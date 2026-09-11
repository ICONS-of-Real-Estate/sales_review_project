'use strict';

/**
 * Regression tests for the pure logic in the .gs files — string/regex
 * parsing, schema validation, and the Cohen's-kappa math. Every bug found
 * and fixed in this codebase so far (an undefined-variable ReferenceError in
 * a catch block, a regex that swallowed hyphens and matched a whole
 * "QC-{id}-{initials}" title instead of isolating the ID inside it, a
 * missing "@google.com" suffix normalization, a duplicate-match overwrite
 * within one sync run) was caught by manual/code-review inspection, not by
 * anything automated. This is a first pass at closing that gap for the
 * functions cheap enough to test without a real Google account.
 *
 * Run: node tests/run_tests.js  (Node's built-in test runner needs no
 * dependencies — this repo has no package.json/npm install step).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadGasProject } = require('./gas_env');

/**
 * A real (not stubbed) Utilities.formatDate, using Node's own Intl support
 * for named IANA timezones, for the handful of tests that exercise
 * dateAtMidnightInBusinessTimezone_/resolveYearForMonthDay_ — those
 * functions exist specifically BECAUSE Utilities.formatDate's real timezone
 * math matters here (see the real bug this closed: the plain multi-arg
 * `new Date(y,m,d)` constructor silently uses the Apps Script project's own
 * default timezone, not the one asked for). Only supports the two patterns
 * those functions actually use ('Z' as a Java-SimpleDateFormat-style
 * "+HHMM"/"-HHMM" offset, and 'yyyy'). Also supports 'yyyy/MM/dd', which
 * businessDayStart_ (and, through it, daysAgoLabel_) needs.
 */
function realFormatDate(date, tz, pattern) {
  if (pattern === 'Z') {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date);
    const m = parts.find((p) => p.type === 'timeZoneName').value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    return m[1] + m[2].padStart(2, '0') + (m[3] || '00');
  }
  if (pattern === 'yyyy') {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(date);
  }
  if (pattern === 'yyyy/MM/dd') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(date).replace(/-/g, '/');
  }
  if (pattern === 'yyyy-MM-dd') {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(date);
  }
  if (pattern === 'HH:mm') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  if (pattern === 'EEEE') {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(date);
  }
  if (pattern === 'EEE') {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  }
  if (pattern === 'dd/MM/yyyy') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
  }
  if (pattern === 'MM') {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit' }).format(date);
  }
  if (pattern === 'dd') {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, day: '2-digit' }).format(date);
  }
  if (pattern === 'HH') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(date);
  }
  if (pattern === 'mm') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(date).split(':')[1];
  }
  if (pattern === 'ss') {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date).split(':')[2];
  }
  throw new Error('realFormatDate: unsupported pattern "' + pattern + '"');
}

const gas = loadGasProject(path.join(__dirname, '..'));

// A transcript fixture long enough to be a REAL call, not a failed recording.
// Phase2's transcriptIsUnusableForScoring_ (added 08/09/2026) refuses to send
// an empty/[BLANK_AUDIO]/near-empty transcript to the model at all, so the old
// two-word 'transcript text' fixture would now be skipped as a dead recording
// rather than scored — which is the guard working, not a bug.
const FAKE_TRANSCRIPT_ = [
  'Rep: Thanks for jumping on, appreciate the time today. Before I get into anything,',
  'tell me a bit about how your business is running right now.',
  'Prospect: Sure. I closed about thirty transactions last year, mostly referral, and',
  'I am trying to get more consistent lead flow without paying for portal leads.',
  'Rep: Got it. And what have you already tried on that front?',
  'Prospect: A bit of social, some door knocking, nothing that really stuck.',
  'Rep: That makes sense. Let me walk you through how we approach that, and then we',
  'can talk about whether it fits. Does that work?',
  'Prospect: Yes, go ahead.'
].join(' ');

test('idsEqual_ treats a bare ID and its @google.com-suffixed form as equal', () => {
  assert.equal(gas.idsEqual_('abc123', 'abc123@google.com'), true);
  assert.equal(gas.idsEqual_('abc123', 'xyz789'), false);
});

test('parseLegacyFilename_ parses the YYYY-MM-DD_ProspectName_Transcript.txt convention and splits CamelCase names', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const parsed = gas.parseLegacyFilename_('2026-08-14_LeiMcDonald_Transcript.txt');
  assert.equal(parsed.dateStr, '2026-08-14');
  assert.equal(parsed.prospectName, 'Lei Mc Donald'); // documented best-effort split; rawSlug keeps the original
  assert.equal(parsed.rawSlug, 'LeiMcDonald');
});

test('parseLegacyFilename_ returns null for a filename that does not match the convention', () => {
  assert.equal(gas.parseLegacyFilename_('random_video.mp4'), null);
});

test('parseLegacyFilename_\'s .date round-trips to the SAME dateStr through loadExistingLegacyKeys_\'s own reformat (real bug: every legacy call got rescored forever)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // The real live bug: parseLegacyFilename_ used to build .date with the plain
  // `new Date(y, m-1, d)` constructor, which silently uses the Apps Script
  // project's own default timezone (Asia/Bangkok, confirmed live in
  // appsscript.json) instead of BUSINESS_TIMEZONE. loadExistingLegacyKeys_
  // reformats that same Date via CONFIG.BUSINESS_TIMEZONE ('America/New_York')
  // to build its dedup key — an ~11-12 hour gap wide enough to roll the date
  // back a full calendar day on every re-read, so the key never matched and
  // scoreLegacyTranscriptFolder rescored + re-appended every legacy transcript
  // on every single firing. This is the same anti-pattern
  // resolveYearForMonthDay_/dateAtMidnightInBusinessTimezone_ already exist to
  // avoid — this test pins the one call site that had been missed.
  const parsed = gas.parseLegacyFilename_('2026-08-18_RebeccaStewart_Transcript.txt');
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.equal(dtf.format(parsed.date), parsed.dateStr);
});

function fakeLegacyFolder_(fileNames, siblingVideosByName) {
  const files = fileNames.map((name) => ({
    getName: () => name,
    getMimeType: () => 'text/plain',
    getBlob: () => ({ getDataAsString: () => FAKE_TRANSCRIPT_ }),
    getUrl: () => 'https://drive.google.com/file/d/fake-' + name + '/view'
  }));
  const siblings = siblingVideosByName || {};
  return {
    getFiles: () => {
      let i = 0;
      return { hasNext: () => i < files.length, next: () => files[i++] };
    },
    getFolders: () => ({ hasNext: () => false, next: () => null }),
    // Sibling video lookup (findSiblingFileUrl_/findSiblingFileCreatedDate_)
    // — defaults to "no match found" (siblingVideosByName omitted), same as
    // the real folder would report for a transcript with no paired video.
    getFilesByName: (name) => {
      const url = siblings[name];
      let served = false;
      return {
        hasNext: () => url !== undefined && !served,
        next: () => { served = true; return { getUrl: () => url, getDateCreated: () => new gas.Date() }; }
      };
    }
  };
}

function fakeLegacySheetFor_(existingRows) {
  const headerRow = gas.SALES_CALL_LOG_HEADERS.slice();
  const appended = [];
  return {
    getLastRow: () => existingRows.length + 1,
    getRange: (row, col, numRows, numCols) => {
      if (row === 1) return { getValues: () => [headerRow] };
      return { getValues: () => existingRows };
    },
    appendRow: (values) => { appended.push(values); },
    _appended: appended
  };
}

test('scoreLegacyTranscriptFolder logs an upfront scope count and a per-file progress line, not just failures (real bug 09/09/2026, Kris: "This needs better logging" — a live Bens pass logged nothing for 3m15s while scoring one file, indistinguishable from a hang, the exact complaint already fixed once on rescoreAllCalls_)', () => {
  // "Mark Ryan" is new; "Tammy De Wolfe" already has a row and must be
  // skipped without ever reaching the model.
  const existingRows = [
    ['Tammy De Wolfe', '', '', new gas.Date(2026, 8, 2, 12, 0, 0), 'Bens']
  ];
  const sheet = fakeLegacySheetFor_(existingRows);
  const folder = fakeLegacyFolder_([
    '2026-08-31_MarkRyan_Transcript.txt',
    '2026-09-02_TammyDeWolfe_Transcript.txt'
  ]);

  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalUtilities = gas.Utilities;
  const originalLog = gas.Logger.log;
  const originalDateNow = Date.now;
  const lines = [];
  let judgeCalls = 0;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.DriveApp = { getFolderById: () => folder };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.Utilities = { formatDate: realFormatDate, sleep() {} };
    gas.Logger.log = (msg) => lines.push(msg);
    let now = 1000000;
    Date.now = () => { now += 5000; return now; }; // fake elapsed time advancing per call

    const judgeFn = () => {
      judgeCalls++;
      return {
        reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 5,
        flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
        framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
        delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
        primary_failure_mode: 'none', manual_review_recommended: false, severity: 1,
        feedback_summary: 'scored'
      };
    };

    gas.scoreLegacyTranscriptFolder('Bens', 'fake-folder-id', judgeFn);

    assert.equal(judgeCalls, 1, 'only the one new file should ever reach the model');
    assert.equal(sheet._appended.length, 1);

    const joined = lines.join('\n');
    assert.match(joined, /scoreLegacyTranscriptFolder\(Bens\): 1 file\(s\) need scoring this pass \(1 already scored, 0 unparsed\)/,
      'must log the real scope up front, before any model call');
    assert.match(joined, /\[1\/1\] Scoring "Mark Ryan" \(2026-08-31\) — calling the model now/,
      'must log BEFORE the model call, since that call can run minutes with nothing else in between');
    assert.match(joined, /\[1\/1\] Done: "Mark Ryan" \(2026-08-31\) — good_to_book, score 5.*elapsed so far/,
      'must log each file as it completes, not stay silent until the end');
    // The upfront scope line must come before the per-file "Scoring" line.
    assert.ok(joined.indexOf('1 file(s) need scoring this pass') < joined.indexOf('Scoring "Mark Ryan"'));
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.Utilities = originalUtilities;
    gas.Logger.log = originalLog;
    Date.now = originalDateNow;
  }
});

test('findSiblingFileUrl_ finds the paired video\'s URL by exact name match, and returns null (never a guessed/constructed URL) when there is no sibling — real ask 09/09/2026, Tomás: "I\'m pretty sure that we can start putting even the recordings there [in the CRM]"', () => {
  const found = { getFilesByName: (name) => {
    if (name !== 'Frank Pirrone.mp4') return { hasNext: () => false };
    let served = false;
    return { hasNext: () => !served, next: () => { served = true; return { getUrl: () => 'https://drive.google.com/file/d/real-video/view' }; } };
  } };
  assert.equal(gas.findSiblingFileUrl_(found, 'Frank Pirrone.mp4'), 'https://drive.google.com/file/d/real-video/view');

  const notFound = { getFilesByName: () => ({ hasNext: () => false }) };
  assert.equal(gas.findSiblingFileUrl_(notFound, 'Nobody.mp4'), null);
});

test('scoreLegacyTranscriptFolder captures the sibling video\'s URL into the new "Recording URL" column when one exists in the same folder, and leaves it blank (not a crash, not a guess) when it does not — Kris, 09/09/2026, clarifying scope: "Sales calls and QCs are not done on Riverside. They\'re done on Zoom. It\'s icons one hundred with Bens that is done on Riverside." Either way the recording ends up as a sibling video file next to its transcript, which is what this actually reads', () => {
  const existingRows = [];
  const sheet = fakeLegacySheetFor_(existingRows);
  // Mark Ryan has a real sibling video sitting next to the transcript;
  // Tammy De Wolfe's transcript has no paired video at all (e.g. she was
  // scored from a bare transcript upload) — both must be handled cleanly.
  const folder = fakeLegacyFolder_(
    ['2026-08-31_MarkRyan_Transcript.txt', '2026-09-02_TammyDeWolfe_Transcript.txt'],
    { 'Mark Ryan': 'https://drive.google.com/file/d/mark-ryan-recording/view' }
  );

  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalUtilities = gas.Utilities;
  const originalLog = gas.Logger.log;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.DriveApp = { getFolderById: () => folder };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.Utilities = { formatDate: realFormatDate, sleep() {} };
    gas.Logger.log = () => {};

    const judgeFn = () => ({
      reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 5,
      flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
      framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
      delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
      primary_failure_mode: 'none', manual_review_recommended: false, severity: 1,
      feedback_summary: 'scored'
    });

    gas.scoreLegacyTranscriptFolder('Bens', 'fake-folder-id', judgeFn);

    const recordingUrlIndex = gas.SALES_CALL_LOG_HEADERS.indexOf('Recording URL');
    assert.ok(recordingUrlIndex !== -1, 'precondition: the column must actually exist in the header list');
    assert.equal(sheet._appended.length, 2);
    const markRyanRow = sheet._appended.filter((r) => r[0] === 'Mark Ryan')[0];
    const tammyRow = sheet._appended.filter((r) => r[0] === 'Tammy De Wolfe')[0];
    assert.equal(markRyanRow[recordingUrlIndex], 'https://drive.google.com/file/d/mark-ryan-recording/view');
    assert.equal(tammyRow[recordingUrlIndex], '', 'no sibling video found — must be blank, never a fabricated URL');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.Utilities = originalUtilities;
    gas.Logger.log = originalLog;
  }
});

test('guessProspectFromTitle_ extracts the prospect name from the real calendar title patterns it documents', () => {
  assert.equal(
    gas.guessProspectFromTitle_('Podcast Qualification Call / Tom Wood and ICONS of Real Estate'),
    'Tom Wood'
  );
  assert.equal(gas.guessProspectFromTitle_('Real Estate Podcast: Andrea Brunson'), 'Andrea Brunson');
});

test('titleLooksLikeSalesOrQcCall_ recognizes Sean\'s "Qualification Call" calendar title convention, not just Bens\' "QC" (real bug found live 03/09/2026: "qualification call" does not contain the substring "qc", so every one of Sean\'s QCs was invisible to getRepCallEvents_/getRepCallEventsRaw_ — no handoff brief before them, no way to notice a QC that never produced a recording)', () => {
  assert.equal(gas.titleLooksLikeSalesOrQcCall_('QC'), true, 'Bens\' bare "QC" title');
  assert.equal(gas.titleLooksLikeSalesOrQcCall_('Podcast Qualification Call / Tom Wood'), true, 'Joana\'s title convention');
  assert.equal(gas.titleLooksLikeSalesOrQcCall_('Qualification Call / Sabiha Razzak'), true,
    'Sean\'s title convention — plain "Qualification Call", no "QC" abbreviation and no "Podcast" prefix');
  assert.equal(gas.titleLooksLikeSalesOrQcCall_('Sales Call / Anthony Camperi'), true);
  assert.equal(gas.titleLooksLikeSalesOrQcCall_('Weekly Team Sync'), false, 'not a sales/QC call at all');
  assert.equal(gas.titleLooksLikeSalesOrQcCall_('Update Tracker - Qualification Call reminder'), false,
    'an EXCLUDE keyword must still win even though "qualification call" also matches an INCLUDE keyword');
});

test('eventLooksInternalOnly_ flags a guest list that is non-empty but entirely internal, leaves an empty list alone (real bug 02/09/2026: Bens\' internal "QC" 1-1 with Joana got nagged as a real sales/QC call)', () => {
  assert.equal(gas.eventLooksInternalOnly_(['joana@iconsofrealestate.com']), true,
    'Bens+Joana internal 1-1, titled plain "QC" — must be recognized as internal-only');
  assert.equal(gas.eventLooksInternalOnly_(['bens@iconsofrealestate.com', 'joana@iconsofrealestate.com']), true);
  assert.equal(gas.eventLooksInternalOnly_(['tom.wood@example.com']), false, 'a real external prospect guest');
  assert.equal(gas.eventLooksInternalOnly_(['joana@iconsofrealestate.com', 'tom.wood@example.com']), false,
    'internal + external mix is a real call, not internal-only');
  assert.equal(gas.eventLooksInternalOnly_([]), false,
    'no guests at all is the separate "prospect never added as a Calendar guest" case — must NOT be filtered here');
});

test('dropInternalOnlyBacklogEntries_ retroactively clears a backlog entry whose live Calendar guest list is now confirmed internal-only, leaves everything else alone (real bug 02/09/2026: Bens\' 3 QC/Joana 1-1s were flagged before the getRepCallEvents_ fix shipped and would be stuck in the backlog forever otherwise)', () => {
  const backlog = [
    { eventId: 'evt-internal', title: 'QC', prospectGuess: '(name not parsed from calendar title)', attendeeEmails: [], callDateLabel: '28/08/2026', time: '10:00' },
    { eventId: 'evt-external', title: 'Joey Lamielle - Icons 100', prospectGuess: 'Joey Lamielle', attendeeEmails: ['joey@example.com'], callDateLabel: '26/08/2026', time: '10:30' },
    { eventId: null, title: 'Old entry, no event ID', prospectGuess: 'Someone', attendeeEmails: [], callDateLabel: '20/08/2026', time: '09:00' },
    { eventId: 'evt-deleted', title: 'Deleted event', prospectGuess: 'Nobody', attendeeEmails: [], callDateLabel: '19/08/2026', time: '09:00' }
  ];
  const lookup = (eventId) => {
    if (eventId === 'evt-internal') return ['joana@iconsofrealestate.com', 'bens@iconsofrealestate.com'];
    if (eventId === 'evt-external') return ['joey@example.com'];
    return null; // deleted/unfound event
  };
  const kept = gas.dropInternalOnlyBacklogEntries_('Bens', backlog, lookup);
  assert.equal(kept.length, 3, 'only the internal-only entry should be dropped');
  assert.ok(!kept.some((e) => e.eventId === 'evt-internal'), 'internal-only entry dropped');
  assert.ok(kept.some((e) => e.eventId === 'evt-external'), 'external prospect entry kept');
  assert.ok(kept.some((e) => e.eventId === null), 'entry with no eventId left alone, not guessed at');
  assert.ok(kept.some((e) => e.eventId === 'evt-deleted'), 'entry whose live lookup failed left alone, not guessed at');
});

test('additionalTeamGuestEmails_ finds a company-domain guest other than the rep the brief is addressed to (Kris 03/09/2026, real case: Stacie Staub\'s Discovery call included her account manager as a guest, but the handoff brief only went to Joana)', () => {
  assert.deepEqual(
    gas.additionalTeamGuestEmails_(['joana@iconsofrealestate.com', 'am.newhire@iconsofrealestate.com', 'stacie@example.com'], 'joana@iconsofrealestate.com'),
    ['am.newhire@iconsofrealestate.com'],
    'the AM must be found even though they are not in the fixed INTERNAL_EMAILS list — a new hire\'s address ' +
    'would not be there yet, which is exactly why this checks the domain, not that roster'
  );
  assert.deepEqual(
    gas.additionalTeamGuestEmails_(['joana@iconsofrealestate.com', 'stacie@example.com'], 'joana@iconsofrealestate.com'),
    [],
    'no additional company-domain guest — nothing to add'
  );
  assert.deepEqual(
    gas.additionalTeamGuestEmails_(['joana@iconsofrealestate.com'], 'joana@iconsofrealestate.com'),
    [],
    'the rep\'s own address must never be returned as an "additional" guest'
  );
  assert.deepEqual(
    gas.additionalTeamGuestEmails_(['stacie@example.com', 'stacie.colleague@example.com'], 'joana@iconsofrealestate.com'),
    [],
    'external guests (a different domain) must never be pulled into an internal handoff-brief CC line'
  );
});

test('buildHandoffBriefCcList_ includes any additional team guest and dedupes, so an AM who happens to be Kris does not get a doubled CC header — Tomás is no longer auto-CC\'d (Kris\'s ask 03/09/2026: "This only needs to go to Joana or the sales rep / CC me so I can see the quality")', () => {
  // Return values come from the vm sandbox's own realm, so assert.deepEqual's
  // prototype-identity check fails against this file's plain array literals
  // for realm reasons, not a real mismatch — compare content directly, same
  // convention as stripFencesAndParseJson_'s test elsewhere in this file.
  assert.equal(
    gas.buildHandoffBriefCcList_('sean@iconsofrealestate.com', ['am.newhire@iconsofrealestate.com']).join(','),
    'sean@iconsofrealestate.com,' + gas.CONFIG.KRIS_EMAIL + ',am.newhire@iconsofrealestate.com'
  );
  assert.equal(
    gas.buildHandoffBriefCcList_('sean@iconsofrealestate.com', [gas.CONFIG.KRIS_EMAIL]).join(','),
    'sean@iconsofrealestate.com,' + gas.CONFIG.KRIS_EMAIL,
    'must not duplicate Kris\'s CC line just because he was also invited as the "additional" guest'
  );
  assert.equal(
    gas.buildHandoffBriefCcList_('sean@iconsofrealestate.com', [gas.CONFIG.TOMAS_EMAIL]).join(','),
    'sean@iconsofrealestate.com,' + gas.CONFIG.KRIS_EMAIL + ',' + gas.CONFIG.TOMAS_EMAIL,
    'Tomás is only CC\'d if he\'s actually an invited guest on the calendar event, not automatically on every brief'
  );
  assert.equal(
    gas.buildHandoffBriefCcList_(null, []).join(','),
    gas.CONFIG.KRIS_EMAIL,
    'a missing prior-rep email (repEmailByName_ found nothing) must be dropped, not sent as null/undefined'
  );
});

test('stripFencesAndParseJson_ strips markdown code fences before parsing', () => {
  const parsed = gas.stripFencesAndParseJson_('```json\n{"a": 1}\n```');
  // parsed.a's JSON.parse ran inside the vm sandbox's own realm, so
  // assert.deepEqual's prototype-identity check would fail against this
  // file's plain object literal for realm reasons, not a real mismatch —
  // compare the actual field instead.
  assert.equal(parsed.a, 1);
});

test('stripFencesAndParseJson_ throws when no JSON object is present, rather than returning something silently wrong', () => {
  assert.throws(() => gas.stripFencesAndParseJson_('not json at all'));
});

test('isValidJudgeSchema_ accepts a well-formed object and rejects one missing a required field', () => {
  const good = {
    lead_quality: { verdict: 'good_to_book' },
    call_quality_score: 4,
    // discovery_adequate/understood_leads_business/confirmed_prior_discovery became
    // required on the shared rubric 03/09/2026 — see deriveDiscoveryFields_'s own test.
    // booked_discovery_call/lead_ready_with_money became required the same day —
    // see deriveBookingDecisionFields_'s own test.
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      discovery_adequate: true, understood_leads_business: true, confirmed_prior_discovery: true,
      booked_discovery_call: false, lead_ready_with_money: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
    manual_review_recommended: false,
    severity: 2
  };
  assert.equal(gas.isValidJudgeSchema_(good), true);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, good, { severity: undefined })), false);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, good, { framework: undefined })), false);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, good, { delivery: undefined })), false);
  assert.equal(gas.isValidJudgeSchema_(null), false);
});

test('deriveFrameworkFields_ grades THE framework, not all three — one well-chosen angle passes, a generic pitch that ignores discovery fails, and a missing framework object still does not throw (reversed 08/09/2026 on Tomás\'s instruction)', () => {
  // Return values come from the vm sandbox's own realm, so assert.deepEqual's
  // prototype-identity check would fail against this file's plain object
  // literals for realm reasons, not a real mismatch — compare fields directly,
  // same convention as stripFencesAndParseJson_'s test above.
  const allThreeMatched = gas.deriveFrameworkFields_({
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true }
  });
  assert.equal(allThreeMatched.explained, true);
  assert.equal(allThreeMatched.gapsText, '');

  // THE central change (Tomás, 08/09/2026): "We're not always going to deliver
  // ALL the frameworks. We're going to deliver THE framework... It's never
  // going to be all of them." One well-chosen angle is a PASS. Under the old
  // rule this exact result failed and the email told Tomás the rep was
  // "missing: recruit agents, sell more houses" — for a job nobody asked
  // them to do.
  const oneAngleWellChosen = gas.deriveFrameworkFields_({
    framework: { recruit_agents_explained: false, number_one_podcast_explained: true, sell_more_houses_explained: false, framework_matched_to_lead: true }
  });
  assert.equal(oneAngleWellChosen.explained, true);
  assert.equal(oneAngleWellChosen.gapsText, '');

  // What DOES fail now: a framework delivered that ignores what discovery
  // surfaced. The gap text says what was delivered, not what was skipped.
  const genericPitch = gas.deriveFrameworkFields_({
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: false, framework_matched_to_lead: false }
  });
  assert.equal(genericPitch.explained, false);
  assert.equal(genericPitch.gapsText, "delivered recruit agents + #1 podcast in your city, but not tied to this lead's own goal or pain");

  const noFramework = gas.deriveFrameworkFields_({
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false, framework_matched_to_lead: false }
  });
  assert.equal(noFramework.explained, false);
  assert.equal(noFramework.gapsText, 'no framework delivered at all');

  // Parse-failure fallbacks and any result shape predating this field must not throw —
  // conservative default is "nothing explained", same policy as manual_review_recommended.
  const missingObject = gas.deriveFrameworkFields_({});
  assert.equal(missingObject.explained, false);
  assert.equal(missingObject.gapsText, 'no framework delivered at all');

  const nullResult = gas.deriveFrameworkFields_(null);
  assert.equal(nullResult.explained, false);
  assert.equal(nullResult.gapsText, 'no framework delivered at all');
});

test('deriveDiscoveryFields_ — judges only the discovery flags a variant actually returned, so the QC rubric (which never scores confirmed_prior_discovery) is not shown a phantom gap for it (Kris 03/09/2026: discovery is one of the 4 elements every rep must be graded on)', () => {
  // Sales-call variant: all three flags scored and passed.
  const allGood = gas.deriveDiscoveryFields_({
    flags: { discovery_adequate: true, understood_leads_business: true, confirmed_prior_discovery: true }
  });
  assert.equal(allGood.adequate, true);
  assert.equal(allGood.gapsText, '');

  // Sales-call variant failing only the confirm/deepen-the-QC piece.
  const noConfirm = gas.deriveDiscoveryFields_({
    flags: { discovery_adequate: true, understood_leads_business: true, confirmed_prior_discovery: false }
  });
  assert.equal(noConfirm.adequate, false);
  assert.equal(noConfirm.gapsText, 'confirming/deepening what the earlier call surfaced');

  // QC/first-touch variant: only two flags exist. The third must NOT be counted
  // as a gap — that would mark every QC down for a conversation that never happened.
  const qcPassing = gas.deriveDiscoveryFields_({
    flags: { discovery_adequate: true, understood_leads_business: true }
  });
  assert.equal(qcPassing.adequate, true, 'a QC with both its flags passed is adequate, not failed by the missing third');
  assert.equal(qcPassing.gapsText, '');

  const qcFailing = gas.deriveDiscoveryFields_({
    flags: { discovery_adequate: false, understood_leads_business: true }
  });
  assert.equal(qcFailing.adequate, false);
  assert.equal(qcFailing.gapsText, 'depth of discovery questioning');

  // A variant that scores no discovery at all, or any pre-existing row shape,
  // must read as blank "no signal" — never as a fabricated failure.
  const noneScored = gas.deriveDiscoveryFields_({ flags: { asked_for_close: true } });
  assert.equal(noneScored.adequate, '', 'no discovery flags at all must be blank, not false');
  assert.equal(noneScored.gapsText, '');

  assert.equal(gas.deriveDiscoveryFields_({}).adequate, '');
  assert.equal(gas.deriveDiscoveryFields_(null).adequate, '', 'must not throw on a null result');
});

test('deriveBookingDecisionFields_ only judges a call that actually booked a Discovery call, and only fails it when the lead never confirmed payment on that call (Kris\'s ask 03/09/2026: "sales reps are lazy, and they book through to a discovery call where it\'s not a hell yes")', () => {
  // No Discovery call booked at all — this dimension does not apply, blank not failure.
  const noBooking = gas.deriveBookingDecisionFields_({
    flags: { booked_discovery_call: false, lead_ready_with_money: false }
  });
  assert.equal(noBooking.appropriate, '', 'must be blank, not false, when no Discovery call was booked');
  assert.equal(noBooking.gapText, '');

  // Discovery booked AND the lead committed to paying — the correct call.
  const goodBooking = gas.deriveBookingDecisionFields_({
    flags: { booked_discovery_call: true, lead_ready_with_money: true }
  });
  assert.equal(goodBooking.appropriate, true);
  assert.equal(goodBooking.gapText, '');

  // Discovery booked WITHOUT the lead committing — the exact "lazy booking" pattern.
  const prematureBooking = gas.deriveBookingDecisionFields_({
    flags: { booked_discovery_call: true, lead_ready_with_money: false }
  });
  assert.equal(prematureBooking.appropriate, false);
  assert.ok(prematureBooking.gapText.indexOf('Second Sales Call with Tomás') !== -1,
    'the gap text must say what should have been booked instead');

  // A variant/sentinel that never scored this dimension at all must read as
  // blank "no signal", never as a fabricated failure — same convention as
  // deriveDiscoveryFields_ above.
  const noneScored = gas.deriveBookingDecisionFields_({ flags: { asked_for_close: true } });
  assert.equal(noneScored.appropriate, '', 'no booking-decision flags at all must be blank, not false');
  assert.equal(noneScored.gapText, '');

  assert.equal(gas.deriveBookingDecisionFields_({}).appropriate, '');
  assert.equal(gas.deriveBookingDecisionFields_(null).appropriate, '', 'must not throw on a null result');
});

test('deriveElevationFields_ only judges a call where the original rep was actually present, and reads blank (not a fabricated failure) when they weren\'t (Kris\'s ask 03/09/2026: "the sales rep needs to elevate the other person... this is Thomas, he\'s amazing... and let the other guys get to it")', () => {
  // Rep never joined this call at all — the AM/Tomás ran it solo. Nothing to fail.
  const repAbsent = gas.deriveElevationFields_({
    flags: { rep_present_on_call: false, elevation_done: true }
  });
  assert.equal(repAbsent.done, '', 'must be blank, not a value, when the rep was never on the call');
  assert.equal(repAbsent.gapText, '');

  // Rep present and did a real handoff.
  const goodElevation = gas.deriveElevationFields_({
    flags: { rep_present_on_call: true, elevation_done: true }
  });
  assert.equal(goodElevation.done, true);
  assert.equal(goodElevation.gapText, '');

  // Rep present but skipped the handoff — the real failure case.
  const missedElevation = gas.deriveElevationFields_({
    flags: { rep_present_on_call: true, elevation_done: false }
  });
  assert.equal(missedElevation.done, false);
  assert.ok(missedElevation.gapText.length > 0, 'a real miss must carry an explanatory gap, not just a bare false');

  // A variant/sentinel that never scored this dimension at all must read as
  // blank "no signal", never as a fabricated failure — same convention as
  // deriveDiscoveryFields_/deriveBookingDecisionFields_ above.
  const noneScored = gas.deriveElevationFields_({ flags: { asked_for_close: true } });
  assert.equal(noneScored.done, '', 'no elevation flags at all must be blank, not false');
  assert.equal(noneScored.gapText, '');

  assert.equal(gas.deriveElevationFields_({}).done, '');
  assert.equal(gas.deriveElevationFields_(null).done, '', 'must not throw on a null result');
});

test('isValidDiscoveryJudgeSchema_ requires the SOP-content fields (goals/guest avatar/branding/launch strategy) AND the rep\'s money_collected_by_rep — NOT the QC rubric\'s booked_next_step, since Discovery calls are a completely different call graded against the real SOP (Kris, 03/09/2026: "Use the SOP when grading disco calls")', () => {
  const good = {
    lead_quality: { verdict: 'good_to_book', justification: 'x' },
    call_quality_score: 4,
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      smart_goals_defined: true, guest_avatar_identified: true,
      branding_preferences_captured: true, launch_strategy_discussed: true,
      money_collected_by_rep: true, rep_present_on_call: true, elevation_done: true
    },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
    manual_review_recommended: false,
    severity: 2,
    root_cause_if_thin_call: 'N/A'
  };
  assert.equal(gas.isValidDiscoveryJudgeSchema_(good), true);
  assert.equal(gas.isValidDiscoveryJudgeSchema_(Object.assign({}, good, { flags: Object.assign({}, good.flags, { smart_goals_defined: undefined }) })), false,
    'must reject a reply missing an SOP-content flag — the whole point of grading against the real SOP');
  assert.equal(gas.isValidDiscoveryJudgeSchema_(Object.assign({}, good, { flags: Object.assign({}, good.flags, { money_collected_by_rep: undefined }) })), false,
    'must reject a reply missing money_collected_by_rep — the rep\'s segment of this call');
  assert.equal(gas.isValidDiscoveryJudgeSchema_(Object.assign({}, good, { root_cause_if_thin_call: undefined })), false);
  assert.equal(gas.isValidDiscoveryJudgeSchema_(null), false);
});

test('deriveDiscoveryContentFields_ grades the AM\'s SOP-content coverage — unlike elevation/booking, a missing flag IS a real gap here, never "not applicable", since covering goals/guest-avatar/branding/launch-strategy is always the AM\'s job on a real Discovery call', () => {
  const allCovered = gas.deriveDiscoveryContentFields_({
    flags: { smart_goals_defined: true, guest_avatar_identified: true, branding_preferences_captured: true, launch_strategy_discussed: true }
  });
  assert.equal(allCovered.covered, true);
  assert.equal(allCovered.gapsText, '');

  const twoGaps = gas.deriveDiscoveryContentFields_({
    flags: { smart_goals_defined: false, guest_avatar_identified: true, branding_preferences_captured: false, launch_strategy_discussed: true }
  });
  assert.equal(twoGaps.covered, false);
  assert.ok(twoGaps.gapsText.indexOf('SMART goals') !== -1 && twoGaps.gapsText.indexOf('branding preferences') !== -1);

  // Missing object (a parse-failure sentinel, or a non-discovery variant's result) reads as
  // every gap listed — deliberately NOT blank, since this dimension is never legitimately
  // not-applicable for an actual Discovery call, unlike elevation/booking-decision.
  const missingObject = gas.deriveDiscoveryContentFields_({});
  assert.equal(missingObject.covered, false);
  assert.ok(missingObject.gapsText.indexOf('SMART goals') !== -1 && missingObject.gapsText.indexOf('guest avatar') !== -1 &&
    missingObject.gapsText.indexOf('branding') !== -1 && missingObject.gapsText.indexOf('launch strategy') !== -1);
});

test('deriveRepPaymentFields_ only judges the ORIGINAL SALES REP\'s payment collection, gated on rep_present_on_call exactly like deriveElevationFields_ (Kris, 03/09/2026: "the sales rep still joins the Discovery call and is responsible for picking up the payment, then they introduce the AM")', () => {
  const repAbsent = gas.deriveRepPaymentFields_({
    flags: { rep_present_on_call: false, money_collected_by_rep: true }
  });
  assert.equal(repAbsent.collected, '', 'must be blank, not a value, when the rep was never on the call — nothing to grade');
  assert.equal(repAbsent.gapText, '');

  const collected = gas.deriveRepPaymentFields_({
    flags: { rep_present_on_call: true, money_collected_by_rep: true }
  });
  assert.equal(collected.collected, true);
  assert.equal(collected.gapText, '');

  const notCollected = gas.deriveRepPaymentFields_({
    flags: { rep_present_on_call: true, money_collected_by_rep: false }
  });
  assert.equal(notCollected.collected, false);
  assert.ok(notCollected.gapText.length > 0);

  assert.equal(gas.deriveRepPaymentFields_({}).collected, '');
  assert.equal(gas.deriveRepPaymentFields_(null).collected, '', 'must not throw on a null result');
});

test('rubricVariantForNewScore_ routes a Discovery call to its own dedicated variant, separate from QC, so buildDiscoveryJudgeSystemPrompt_/scoreDiscoveryTranscript_ actually get used (03/09/2026)', () => {
  assert.equal(gas.rubricVariantForNewScore_('Sean', 'Discovery'), 'discovery');
  assert.equal(gas.scoreTranscriptByVariant_ !== undefined, true, 'scoreTranscriptByVariant_ must exist to dispatch to it');
});

test('Sales Call Log has columns for the booking-decision, elevation, and Discovery-SOP-content/rep-payment dimensions added 03/09/2026', () => {
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Flag: Booking Decision Appropriate') !== -1);
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Booking Decision Gap') !== -1);
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Flag: Elevation Done') !== -1);
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Elevation Gap') !== -1);
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Flag: Discovery Content Covered') !== -1);
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Discovery Content Gaps') !== -1);
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Flag: Payment Collected By Rep') !== -1);
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Payment Collected By Rep Gap') !== -1);
});

test('every judge variant that scores discovery returns flags deriveDiscoveryFields_ can actually read, and the Sales Call Log has columns to put them in', () => {
  // The whole point of the 03/09/2026 change: three variants already JUDGED
  // discovery but there was no column to write it to, so it could never be
  // tallied or trained on. Pin both halves — the flags exist in the schema
  // validators, and the columns exist in the header list.
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Flag: Discovery Adequate') !== -1,
    'Sales Call Log must have a Flag: Discovery Adequate column');
  assert.ok(gas.SALES_CALL_LOG_HEADERS.indexOf('Discovery Gaps') !== -1,
    'Sales Call Log must have a Discovery Gaps column');

  // The shared rubric (Joana) and Tomás's rubric did not score discovery at all
  // before this change — their validators must now require it, otherwise a
  // model reply omitting discovery would still be accepted as a valid score.
  const sharedBase = {
    lead_quality: { verdict: 'good_to_book', justification: 'x' },
    call_quality_score: 3,
    flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
    manual_review_recommended: false,
    severity: 2
  };
  assert.equal(gas.isValidJudgeSchema_(sharedBase), false,
    'shared/Joana rubric must reject a reply with no discovery flags');

  sharedBase.flags.discovery_adequate = true;
  sharedBase.flags.understood_leads_business = true;
  sharedBase.flags.confirmed_prior_discovery = true;
  assert.equal(gas.isValidJudgeSchema_(sharedBase), false,
    'shared/Joana rubric must also reject a reply with discovery scored but no booking-decision flags (03/09/2026)');

  sharedBase.flags.booked_discovery_call = false;
  sharedBase.flags.lead_ready_with_money = true;
  assert.equal(gas.isValidJudgeSchema_(sharedBase), true,
    'shared/Joana rubric accepts the reply once discovery AND booking-decision are both scored');
});

test('deriveDeliveryFields_ — both covered means no gaps; a missing delivery object means every gap listed, not a throw (29/08/2026, same pattern as deriveFrameworkFields_)', () => {
  const bothCovered = gas.deriveDeliveryFields_({
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true }
  });
  assert.equal(bothCovered.effective, true);
  assert.equal(bothCovered.gapsText, '');

  const oneGap = gas.deriveDeliveryFields_({
    delivery: { paced_appropriately: false, adapted_to_lead_engagement: true }
  });
  assert.equal(oneGap.effective, false);
  assert.equal(oneGap.gapsText, 'pacing/time-awareness');

  const missingObject = gas.deriveDeliveryFields_({});
  assert.equal(missingObject.effective, false);
  assert.equal(missingObject.gapsText, 'pacing/time-awareness, reading and adapting to the lead\'s engagement');

  const nullResult = gas.deriveDeliveryFields_(null);
  assert.equal(nullResult.effective, false);
  assert.equal(nullResult.gapsText, 'pacing/time-awareness, reading and adapting to the lead\'s engagement');
});

test('findColumn_ matches header names case-insensitively and tries candidates in priority order', () => {
  const header = ['Name', 'Call Taken', 'Comments'];
  assert.equal(gas.findColumn_(header, ['Outcome Logged', 'Call Taken']), 1);
  assert.equal(gas.findColumn_(header, ['Nonexistent']), -1);
});

test('runDailyComplianceCheck skips entirely on a weekend (business timezone) rather than just suppressing sends (real bug, 30/08/2026: the daily trigger fires every day via everyDays(1) — Apps Script has no weekday-only trigger option — so a real compliance nag went out on a Sunday)', () => {
  const originalUtilities = gas.Utilities;
  const originalLockService = gas.LockService;
  const originalLog = gas.Logger.log;
  const originalEnabled = gas.COMPLIANCE_CHECK_CONFIG.ENABLED;
  const lines = [];
  try {
    // Re-enabled just for this test: COMPLIANCE_CHECK_CONFIG.ENABLED is
    // false by default (05/09/2026, Kris: "We don't want any trackers.
    // Everything in GHL") — this test targets the weekday-skip logic
    // beneath that gate, not the gate itself.
    gas.COMPLIANCE_CHECK_CONFIG.ENABLED = true;
    gas.Utilities = { formatDate: (d, tz, pattern) => (pattern === 'EEE' ? 'Sun' : realFormatDate(d, tz, pattern)) };
    // LockService is the very next thing touched after the weekday check —
    // making it throw proves the function exits before any real work
    // starts, not just before sending.
    gas.LockService = { getScriptLock: () => { throw new Error('must not attempt to acquire the lock on a weekend'); } };
    gas.Logger.log = (msg) => lines.push(msg);

    gas.runDailyComplianceCheck();

    assert.match(lines.join('\n'), /Sun — weekday-only check \(Mon-Fri\), skipping\./);
  } finally {
    gas.Utilities = originalUtilities;
    gas.LockService = originalLockService;
    gas.Logger.log = originalLog;
    gas.COMPLIANCE_CHECK_CONFIG.ENABLED = originalEnabled;
  }
});

test('with COMPLIANCE_CHECK_CONFIG.ENABLED false, the nag EMAILS stop but the calendar-to-sheet match/stamp pass still runs (real regression, 08/09/2026)', () => {
  // Kris, 05/09/2026: "We need to stop this email... We don't want any
  // trackers. Everything in GHL." That instruction is about the EMAILS.
  // Returning early here also stopped checkRep_ -> stampMatch_, the only
  // thing that writes Match Method 'exact_key' — which scoreNewlyLoggedCalls_
  // requires before it will score anything, and which the handoff briefs then
  // need in turn (they look for a prior SCORED call). One flag was gating
  // three unrelated things, and Joana noticed three days later: "I'm not
  // receiving them in the last days."
  const originalLockService = gas.LockService;
  const originalLog = gas.Logger.log;
  const originalEnabled = gas.COMPLIANCE_CHECK_CONFIG.ENABLED;
  const originalCheckRep = gas.checkRep_;
  const originalReps = gas.CONFIG.REPS;
  const originalUtilities = gas.Utilities;
  const originalSession = gas.Session;
  const lines = [];
  let checkedReps = 0;
  try {
    gas.COMPLIANCE_CHECK_CONFIG.ENABLED = false;
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.Logger.log = (msg) => lines.push(msg);
    gas.Utilities = { formatDate: realFormatDate, sleep() {} };
    gas.Session = { getScriptTimeZone: () => gas.CONFIG.BUSINESS_TIMEZONE };
    gas.CONFIG.REPS = [{ name: 'Joana', email: 'joana@iconsofrealestate.com' }];
    gas.checkRep_ = () => { checkedReps++; };

    gas.runDailyComplianceCheck();

    assert.equal(checkedReps, 1, 'the match/stamp pass MUST still run — scoring and handoffs depend on it');
    const joined = lines.join('\n');
    assert.match(joined, /ENABLED is false/, 'and it must still say plainly that the nags are off');
    assert.match(joined, /match/i, 'and say what it is still doing, so this cannot look like a bug next time');
  } finally {
    gas.LockService = originalLockService;
    gas.Logger.log = originalLog;
    gas.COMPLIANCE_CHECK_CONFIG.ENABLED = originalEnabled;
    gas.checkRep_ = originalCheckRep;
    gas.CONFIG.REPS = originalReps;
    gas.Utilities = originalUtilities;
    gas.Session = originalSession;
  }
});

test('checkRep_ sends no nag email and no escalation while the nags are disabled, however much backlog it finds', () => {
  const originalEnabled = gas.COMPLIANCE_CHECK_CONFIG.ENABLED;
  const originalSendCompliance = gas.sendComplianceEmail_;
  const originalOpsAlert = gas.sendOpsAlert_;
  const originalGetEvents = gas.getRepCallEvents_;
  const originalLoadBacklog = gas.loadComplianceBacklog_;
  const originalSaveBacklog = gas.saveComplianceBacklog_;
  const originalLog = gas.log_;
  const originalDropInternal = gas.dropInternalOnlyBacklogEntries_;
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalResolveSheet = gas.resolveSheet_;
  const originalGetAllTrackerRows = gas.getAllTrackerRows_;
  let sends = 0, alerts = 0, saved = 0;
  try {
    gas.COMPLIANCE_CHECK_CONFIG.ENABLED = false;
    gas.log_ = () => {};
    gas.sendComplianceEmail_ = () => { sends++; };
    gas.sendOpsAlert_ = () => { alerts++; };
    gas.getRepCallEvents_ = () => [];
    // A non-empty backlog is exactly the state that would normally email.
    gas.loadComplianceBacklog_ = () => ([{ eventId: 'e1', prospectGuess: 'Someone', firstFlaggedDay: '01/09/2026',
      callDateLabel: '01/09/2026', time: '10:00', title: 'QC / Someone' }]);
    gas.saveComplianceBacklog_ = () => { saved++; };
    gas.dropInternalOnlyBacklogEntries_ = (rep, backlog) => backlog;
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => null, getSheets: () => [] }) };
    // checkRep_ re-reads tracker rows while ageing the backlog; none of that
    // is what this test is about, so it's stubbed to an empty sheet view.
    gas.resolveSheet_ = () => ({ getLastRow: () => 1, getRange: () => ({ getValues: () => [] }), getName: () => 'Sales Call Log' });
    gas.getAllTrackerRows_ = () => [];

    gas.checkRep_({ name: 'Joana', email: 'joana@iconsofrealestate.com' },
      new Date(), new Date(), '08/09/2026', gas.CONFIG.BUSINESS_TIMEZONE);

    assert.equal(sends, 0, 'no daily nag while disabled — that is the instruction');
    assert.equal(alerts, 0, 'and no ops escalation email either');
  } finally {
    gas.COMPLIANCE_CHECK_CONFIG.ENABLED = originalEnabled;
    gas.sendComplianceEmail_ = originalSendCompliance;
    gas.sendOpsAlert_ = originalOpsAlert;
    gas.getRepCallEvents_ = originalGetEvents;
    gas.loadComplianceBacklog_ = originalLoadBacklog;
    gas.saveComplianceBacklog_ = originalSaveBacklog;
    gas.log_ = originalLog;
    gas.dropInternalOnlyBacklogEntries_ = originalDropInternal;
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.resolveSheet_ = originalResolveSheet;
    gas.getAllTrackerRows_ = originalGetAllTrackerRows;
  }
});

test('isTruthyOutcome_ recognizes the documented truthy spellings and rejects blank/false', () => {
  ['TRUE', 'yes', 'y', 'x', '✓', 'done', '1'].forEach((v) => {
    assert.equal(gas.isTruthyOutcome_(v), true, 'expected "' + v + '" to be truthy');
  });
  assert.equal(gas.isTruthyOutcome_(''), false);
  assert.equal(gas.isTruthyOutcome_(false), false);
  // Built via the sandbox's OWN Date constructor (see gas_env.js) — a Date
  // built in this file's realm would fail isTruthyOutcome_'s `instanceof
  // Date` check for the wrong reason (cross-realm identity), not because of
  // any real bug.
  assert.equal(gas.isTruthyOutcome_(new gas.Date()), true);
});

// Array/object return values here were built inside the vm sandbox's own
// realm (see gas_env.js's Date comment) — assert.deepEqual's
// constructor-identity check fails against this file's plain array literals
// for realm reasons, not a real mismatch, so compare contents via a plain
// Array copy instead, same workaround the existing tests above already use.
test('pickRandomSample_ picks exactly n items with a deterministic randomFn, no duplicates', () => {
  const items = ['a', 'b', 'c', 'd'];
  // randomFn always returning 0 always picks the current pool's first
  // element, so results are deterministic and easy to reason about: a, then
  // b (a already removed), etc.
  const sample = gas.pickRandomSample_(items, 2, () => 0);
  assert.deepEqual(Array.prototype.slice.call(sample), ['a', 'b']);
});

test('pickRandomSample_ caps at the pool size instead of throwing or padding when n exceeds it', () => {
  const sample = gas.pickRandomSample_(['a', 'b'], 5, () => 0);
  assert.equal(sample.length, 2);
  assert.deepEqual(Array.prototype.slice.call(sample).sort(), ['a', 'b']);
});

test('pickRandomSample_ does not mutate the input array', () => {
  const items = ['a', 'b', 'c'];
  gas.pickRandomSample_(items, 2, () => 0.99);
  assert.deepEqual(items, ['a', 'b', 'c']);
});

test('pickRandomSample_ returns empty for an empty pool or n=0', () => {
  assert.equal(gas.pickRandomSample_([], 3, () => 0).length, 0);
  assert.equal(gas.pickRandomSample_(['a'], 0, () => 0).length, 0);
});

test('pickOneCallPerRep_ picks exactly one call per distinct rep, never two from the same rep', () => {
  // Sean has 3 eligible rows, Joana has 1, Tomás has 0 — the real bug
  // (04/09/2026 digest): a flat pickRandomSample_ over the combined pool
  // drew Sean twice and skipped Joana entirely, purely because Sean had
  // more rows in the pool. Grouping first must guarantee one each.
  const eligible = [
    { rowIndex: 1, rep: 'Sean' },
    { rowIndex: 2, rep: 'Sean' },
    { rowIndex: 3, rep: 'Sean' },
    { rowIndex: 4, rep: 'Joana' }
  ];
  const sample = gas.pickOneCallPerRep_(eligible, () => 0);
  assert.equal(sample.length, 2, 'expected exactly one call per distinct rep (Sean, Joana)');
  const reps = Array.prototype.slice.call(sample).map((c) => c.rep).sort();
  assert.deepEqual(reps, ['Joana', 'Sean']);
});

test('pickOneCallPerRep_ uses randomFn to choose WHICH call within a rep\'s group, not just the first', () => {
  const eligible = [
    { rowIndex: 10, rep: 'Sean' },
    { rowIndex: 20, rep: 'Sean' },
    { rowIndex: 30, rep: 'Sean' }
  ];
  const sample = gas.pickOneCallPerRep_(eligible, () => 0.99);
  assert.equal(sample.length, 1);
  assert.equal(sample[0].rowIndex, 30, 'randomFn close to 1 should pick the last item in the group');
});

test('pickOneCallPerRep_ returns empty for an empty pool', () => {
  assert.equal(gas.pickOneCallPerRep_([], () => 0).length, 0);
});

test('pickDuplicateRowsToDelete_ leaves distinct (rep, name, date) rows alone', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'A', dateKey: '2026-08-17', transcriptUrl: 'https://drive/A', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 3, rep: 'Bens', prospectName: 'B', dateKey: '2026-08-17', transcriptUrl: 'https://drive/B', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
  ];
  assert.equal(gas.pickDuplicateRowsToDelete_(rows).length, 0);
});

test('pickDuplicateRowsToDelete_ never touches exact_key rows, even with a repeated (name, date)', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'A', dateKey: '2026-08-17', transcriptUrl: 'https://drive/A', matchMethod: 'exact_key', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 3, rep: 'Bens', prospectName: 'A', dateKey: '2026-08-17', transcriptUrl: 'https://drive/A', matchMethod: 'exact_key', reviewedByKris: false, krisVerdict: '' }
  ];
  assert.equal(gas.pickDuplicateRowsToDelete_(rows).length, 0);
});

test('pickDuplicateRowsToDelete_ keeps the lowest row number among otherwise-equal duplicates, deletes the rest', () => {
  const rows = [
    { rowIndex: 5, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', transcriptUrl: 'https://drive/rebecca', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 2, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', transcriptUrl: 'https://drive/rebecca', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 9, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', transcriptUrl: 'https://drive/rebecca', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
  ];
  const toDelete = gas.pickDuplicateRowsToDelete_(rows);
  assert.equal(toDelete.length, 2);
  // .map/.sort on an array from the vm sandbox's realm still return a
  // sandbox-realm array (species-constructed) — deepEqual's constructor
  // check fails against this file's plain array literal for realm reasons,
  // not a real mismatch, same workaround as the other cross-realm tests above.
  assert.deepEqual(Array.prototype.slice.call(toDelete.map((r) => r.rowIndex)).sort(), [5, 9]);
});

test('pickDuplicateRowsToDelete_ preserves a row with a real Kris verdict over an unreviewed duplicate, regardless of row order', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', transcriptUrl: 'https://drive/rebecca', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 20, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', transcriptUrl: 'https://drive/rebecca', matchMethod: 'fallback_heuristic', reviewedByKris: true, krisVerdict: 'Yes' }
  ];
  const toDelete = gas.pickDuplicateRowsToDelete_(rows);
  assert.equal(toDelete.length, 1);
  assert.equal(toDelete[0].rowIndex, 2, 'should delete the unreviewed row, keeping the one with a real Kris verdict');
});

test('pickDuplicateRowsToDelete_ groups separately per rep even with the same name/date/transcript', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'Chad Davis', dateKey: '2026-08-11', transcriptUrl: 'https://drive/chad', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 3, rep: 'Sean', prospectName: 'Chad Davis', dateKey: '2026-08-11', transcriptUrl: 'https://drive/chad', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
  ];
  assert.equal(gas.pickDuplicateRowsToDelete_(rows).length, 0);
});

test('pickDuplicateRowsToDelete_ catches the SAME transcript scored twice under two different dates one day apart (real bug, live 09/09/2026, Kris: "Some are duplicate" on the Bens dashboard)', () => {
  // Root cause confirmed live against the real sheet: parseLegacyFilename_'s
  // own 25/08/2026 timezone fix changed how a legacy file's Call Date gets
  // computed going forward, but rows already scored under the OLD (off-by-
  // one) date never got touched — so the next run's dedup key (name+date+
  // rep) no longer matched those old rows, and the identical transcript got
  // rescored and reappended under its now-correct, one-day-different date.
  // The (rep, name, date) key used to miss this entirely; Transcript URL
  // does not.
  const rows = [
    { rowIndex: 179, rep: 'Bens', prospectName: 'Crystal Gargiulo', dateKey: '2026-08-17', transcriptUrl: 'https://drive.google.com/file/d/14K1yBGvZP6MuEkUlMGgLZTW3zjPRj_TA/view', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 289, rep: 'Bens', prospectName: 'Crystal Gargiulo', dateKey: '2026-08-18', transcriptUrl: 'https://drive.google.com/file/d/14K1yBGvZP6MuEkUlMGgLZTW3zjPRj_TA/view', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
  ];
  const toDelete = gas.pickDuplicateRowsToDelete_(rows);
  assert.equal(toDelete.length, 1, 'same Transcript URL must be caught as a duplicate even though name/date matched exactly before but the dates now differ');
  assert.equal(toDelete[0].rowIndex, 289, 'keeps the lower row number (the original scoring), deletes the later re-score');
});

test('pickDuplicateRowsToDelete_ falls back to the old (rep, name, date) key only when a row genuinely has no transcript URL', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'No Transcript Guy', dateKey: '2026-08-17', transcriptUrl: '', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 3, rep: 'Bens', prospectName: 'No Transcript Guy', dateKey: '2026-08-17', transcriptUrl: '', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
  ];
  assert.equal(gas.pickDuplicateRowsToDelete_(rows).length, 1, 'still catches the old-style duplicate when neither row has a transcript URL to key on');
});

// Plain object returns here come from the vm sandbox's own realm (see
// gas_env.js's Date comment) — assert.deepEqual's constructor-identity check
// fails against this file's plain object literals for realm reasons, not a
// real mismatch, so compare fields individually, same workaround as the
// other cross-realm tests above.
test('parseDateFromTitlePrefix_ extracts M/D from Sean/Tomás-style titles', () => {
  const a = gas.parseDateFromTitlePrefix_('1/21 Anthony Camperi');
  assert.equal(a.month, 1); assert.equal(a.day, 21);
  const b = gas.parseDateFromTitlePrefix_('6/3  Tyrone Mingo');
  assert.equal(b.month, 6); assert.equal(b.day, 3);
  const c = gas.parseDateFromTitlePrefix_('07/13  Patrick Beam');
  assert.equal(c.month, 7); assert.equal(c.day, 13);
});

test('parseDateFromTitlePrefix_ returns null for titles with no date prefix (Joana\'s convention)', () => {
  assert.equal(gas.parseDateFromTitlePrefix_('Kelli Eggen QC & SC.mp4'), null);
  assert.equal(gas.parseDateFromTitlePrefix_('Will Salinas SC.mp4'), null);
});

test('parseDateFromTitlePrefix_ rejects an out-of-range month/day rather than misparsing something else that looks like M/D', () => {
  assert.equal(gas.parseDateFromTitlePrefix_('13/40 Not A Date'), null);
});

// All four tests below read gas.CONFIG.BUSINESS_TIMEZONE directly (whatever
// the real Phase1_ComplianceCheck.gs config currently sets it to) rather than
// hardcoding a zone name, so they keep testing the actual configured
// behavior even if that zone changes again later.
test('resolveYearForMonthDay_ uses the ceiling date\'s own year when the month/day already falls on or before it', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Video uploaded 2026-08-21; call on 1/21 -> clearly earlier the same year.
  const result = gas.resolveYearForMonthDay_({ month: 1, day: 21 }, new gas.Date(2026, 7, 21));
  // Compare via the SAME real-timezone formatter, not getFullYear()/getMonth()/
  // getDate() -- those read the *script's own default timezone*, exactly the
  // thing this function exists to route around (see its own docstring).
  assert.equal(realFormatDate(result, tz, 'yyyy'), '2026');
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.equal(dtf.format(result), '2026-01-21');
});

test('resolveYearForMonthDay_ steps back a year when the same-year candidate would be in the future relative to the ceiling', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Video uploaded 2026-02-01; a "12/15" call can't have happened in the same
  // year AFTER the upload -- must be 12/15 of the PRIOR year.
  const result = gas.resolveYearForMonthDay_({ month: 12, day: 15 }, new gas.Date(2026, 1, 1));
  assert.equal(realFormatDate(result, tz, 'yyyy'), '2025');
});

test('resolveYearForMonthDay_ builds a date that actually round-trips to the right calendar day in BUSINESS_TIMEZONE (the real bug: off by one day)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // The real live bug: the script project's own default timezone (GMT+7,
  // confirmed live) is many hours off from BUSINESS_TIMEZONE -- enough to
  // roll midnight back to the previous calendar day if built with the plain
  // `new Date(y, m, d)` constructor instead of this function.
  const result = gas.resolveYearForMonthDay_({ month: 1, day: 21 }, new gas.Date(2026, 7, 21));
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.equal(dtf.format(result), '2026-01-21');
});

test('resolveYearForMonthDay_ does not roll back a year when the ceiling is the SAME call\'s own video, created just after UTC midnight (real bug: Sean\'s "4/2 Margaret Bruno prep call for DISCO")', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Drive's createdTime is UTC. A video created 2026-04-02T00:13:39Z reads
  // back as 2026-04-01 ~8pm in America/New_York (UTC-4 in April) -- the
  // evening BEFORE the titled day, purely from the UTC/business-timezone
  // offset, not because the call actually happened a year earlier. Without
  // slack for this, midnight-of-4/2-Eastern compares as "later" than that
  // instant and this function wrongly stepped back to 2025.
  const ceiling = new gas.Date(Date.UTC(2026, 3, 2, 0, 13, 39));
  const result = gas.resolveYearForMonthDay_({ month: 4, day: 2 }, ceiling);
  assert.equal(realFormatDate(result, tz, 'yyyy'), '2026');
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.equal(dtf.format(result), '2026-04-02');
});

test('resolveRealCallDate_ prefers a parsed title date over the sibling video\'s own date (Sean/Tomás convention)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const fakeFolder = {
    getFilesByName: () => ({
      hasNext: () => true,
      next: () => ({ getDateCreated: () => new gas.Date(2026, 7, 20) }) // video uploaded 8/20, well after the call
    })
  };
  const fakeTranscriptFile = { getDateCreated: () => new gas.Date(2026, 7, 21) }; // transcribed even later
  const result = gas.resolveRealCallDate_(fakeFolder, '1/21 Anthony Camperi', fakeTranscriptFile);
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  assert.equal(dtf.format(result), '2026-01-21');
});

test('resolveRealCallDate_ falls back to the sibling video\'s own date when the title has no date (Joana\'s convention)', () => {
  const videoDate = new gas.Date(2026, 7, 11); // real upload date
  const fakeFolder = {
    getFilesByName: () => ({ hasNext: () => true, next: () => ({ getDateCreated: () => videoDate }) })
  };
  const fakeTranscriptFile = { getDateCreated: () => new gas.Date(2026, 7, 21) }; // transcribed 10 days later
  const result = gas.resolveRealCallDate_(fakeFolder, 'Kelli Eggen QC & SC.mp4', fakeTranscriptFile);
  assert.equal(result.getTime(), videoDate.getTime());
});

test('resolveRealCallDate_ falls back to the transcript\'s own date only when no sibling video is found at all', () => {
  const fakeFolder = { getFilesByName: () => ({ hasNext: () => false }) };
  const transcriptDate = new gas.Date(2026, 7, 21);
  const fakeTranscriptFile = { getDateCreated: () => transcriptDate };
  const result = gas.resolveRealCallDate_(fakeFolder, 'Some Orphaned Transcript', fakeTranscriptFile);
  assert.equal(result.getTime(), transcriptDate.getTime());
});

test('computeAgreementStats_ returns kappa=1 for perfect agreement', () => {
  const stats = gas.computeAgreementStats_(10, 0, 0, 10);
  assert.equal(stats.n, 20);
  assert.equal(stats.percentAgreement, 1);
  assert.equal(stats.kappa, 1);
});

test('computeAgreementStats_ returns kappa=0 when agreement is exactly at the chance-expected rate', () => {
  const stats = gas.computeAgreementStats_(5, 5, 5, 5);
  assert.equal(stats.percentAgreement, 0.5);
  assert.equal(stats.kappa, 0);
});

test('computeAgreementStats_ matches a known worked kappa example (n=50, po=0.7, pe=0.5, kappa=0.4)', () => {
  const stats = gas.computeAgreementStats_(20, 10, 5, 15);
  assert.equal(stats.n, 50);
  assert.equal(stats.percentAgreement, 0.7);
  assert.ok(Math.abs(stats.kappa - 0.4) < 1e-9);
});

test('mean_ returns null for an empty array (so "no data" is distinguishable from a real 0) and the correct average otherwise', () => {
  assert.equal(gas.mean_([]), null);
  assert.equal(gas.mean_([2, 4]), 3);
});

test('mostFrequent_ picks the most common value, alphabetical tie-break for determinism', () => {
  assert.equal(gas.mostFrequent_([]), null);
  // Returned objects are built inside the vm sandbox's own realm (see
  // gas_env.js's Date comment) — deepEqual's constructor-identity check fails
  // against a plain literal here for realm reasons, so compare fields instead.
  const majority = gas.mostFrequent_(['a', 'b', 'a']);
  assert.equal(majority.value, 'a');
  assert.equal(majority.count, 2);
  // exact tie between 'b' and 'a' -> alphabetically first wins, not insertion order
  const tie = gas.mostFrequent_(['b', 'a']);
  assert.equal(tie.value, 'a');
  assert.equal(tie.count, 1);
});

// col map covers only the fields computeRepWeeklyStats_ actually reads —
// indices are arbitrary as long as they're consistent with the row arrays below.
const SCORECARD_COL = {
  'Rep': 1, 'Prospect Name': 2, 'Call Date': 3, 'Call Quality Score': 4,
  'Primary Failure Mode': 5, 'Flag: Asked For Close': 6, 'Flag: Objections Handled': 7,
  'AI Feedback Summary': 8, 'Outcome Disposition': 9, 'Transcript URL': 10, 'Manual Review Recommended': 11,
  'Call Type': 12
};

function scorecardRow(gas, { rep, name, date, score, pfm, askedForClose, objectionsHandled, feedbackSummary, outcomeDisposition, transcriptUrl, manualReviewRecommended, callType }) {
  return [rep, name, date, score, pfm || '', askedForClose, objectionsHandled, feedbackSummary || '', outcomeDisposition || '', transcriptUrl || '', manualReviewRecommended === true, callType || ''];
}

// computeRepWeeklyStats_ now derives its rolling-4-week window via
// shiftBusinessDate_ (Utilities.formatDate-based, business-tz-correct) —
// weekStart/weekEnd and every row date below must be REAL business-tz
// midnights (as production's mondayAtMidnight_/dateAtMidnightInBusinessTimezone_
// produce), not a naive `new Date(y,m,d)` in the test runner's own local
// timezone, or the two can disagree about which calendar day an instant falls on.
function bizDate(gas, y, m, d) {
  return gas.dateAtMidnightInBusinessTimezone_(y, m, d);
}

test('computeRepWeeklyStats_ separates this week\'s calls from historic ones, per rep, and tallies flags/failure modes', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4, pfm: 'no_close_ask', askedForClose: false, objectionsHandled: true }),
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: bizDate(gas, 2026, 8, 12), score: 2, pfm: 'no_close_ask', askedForClose: false, objectionsHandled: false }),
    scorecardRow(gas, { rep: 'Sean', name: 'C', date: bizDate(gas, 2026, 8, 3), score: 5, pfm: 'none', askedForClose: true, objectionsHandled: true }), // before the week
    scorecardRow(gas, { rep: 'Bens', name: 'D', date: bizDate(gas, 2026, 8, 11), score: 1, pfm: 'objections_missed', askedForClose: true, objectionsHandled: false }) // different rep
  ];

  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.weekCalls.length, 2);
  assert.equal(stats.weeklyAvg, 3);
  assert.ok(Math.abs(stats.historicAvg - 11 / 3) < 1e-9);
  assert.equal(stats.historicAvgBeforeThisWeek, 5);
  assert.equal(stats.historicCount, 3);
  // Array/object values here were built inside the vm sandbox's own realm (see
  // gas_env.js's Date comment) — deepEqual's constructor-identity check fails
  // against this file's plain literals for realm reasons, not a real mismatch,
  // so compare contents field-by-field instead.
  assert.equal(stats.weekFailureModes.length, 2);
  assert.equal(stats.weekFailureModes[0], 'no_close_ask');
  assert.equal(stats.weekFailureModes[1], 'no_close_ask');
  assert.equal(stats.weekFlagMiss.askedForClose, 2);
  assert.equal(stats.weekFlagMiss.objectionsHandled, 1);
  // Rolling window is [weekEnd - 28 days, weekEnd) = [13/07, 17/08) here, so
  // row C (03/08) falls inside it even though it's before this week — all
  // three of Sean's scores count, none of Bens's.
  assert.equal(stats.rolling4WeekCount, 3);
  assert.ok(Math.abs(stats.rolling4WeekAvg - 11 / 3) < 1e-9);
});

test('computeRepWeeklyStats_ rolling 4-week average excludes calls older than the 28-day window', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4, askedForClose: true, objectionsHandled: true }),
    // 40 days before weekEnd — outside the 28-day rolling window entirely.
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: bizDate(gas, 2026, 7, 8), score: 1, askedForClose: true, objectionsHandled: true })
  ];

  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.rolling4WeekCount, 1);
  assert.equal(stats.rolling4WeekAvg, 4);
  // The old call is still counted in the all-time historic average, just not the rolling one.
  assert.equal(stats.historicCount, 2);
});

test('computeRepWeeklyStats_ identifies the week\'s lowest-scoring call as worstCall, carrying its feedback summary', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4, feedbackSummary: 'Good call.' }),
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: bizDate(gas, 2026, 8, 12), score: 2, feedbackSummary: '"I guess we could talk price" — you let that sit instead of isolating it.' })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.worstCall.name, 'B');
  assert.equal(stats.worstCall.score, 2);
  assert.ok(stats.worstCall.feedbackSummary.indexOf('isolating') !== -1);
});

test('computeRepWeeklyStats_ carries transcriptUrl into each week call', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [
    scorecardRow(gas, {
      rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4,
      feedbackSummary: 'Fine call.', transcriptUrl: 'https://docs.google.com/document/d/abc/edit',
      manualReviewRecommended: false
    })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  const callA = stats.weekCalls.filter((c) => c.name === 'A')[0];
  assert.equal(callA.transcriptUrl, 'https://docs.google.com/document/d/abc/edit');
});

test('computeRepWeeklyStats_ excludes a manual-review-flagged call from every score-based stat, real case: April Stephens (Joana), "[BLANK_AUDIO]" for the whole recording scored 1/5 and won "worst call of the week" despite nothing ever being heard (Tomás\'s comment, 03/09/2026: "obvious mistake here, it cant be a 1/5 if it didn\'t even listen to it")', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 24);
  const weekEnd = bizDate(gas, 2026, 8, 31);
  const rows = [
    scorecardRow(gas, {
      rep: 'Joana', name: 'April Stephens', date: bizDate(gas, 2026, 8, 26), score: 1,
      feedbackSummary: 'The only thing on this record is "[BLANK_AUDIO]".',
      transcriptUrl: 'https://docs.google.com/document/d/xyz/edit', manualReviewRecommended: true
    }),
    scorecardRow(gas, {
      rep: 'Joana', name: 'A Real Call', date: bizDate(gas, 2026, 8, 26), score: 4, manualReviewRecommended: false
    })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Joana', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);

  assert.equal(stats.weekCalls.length, 1, 'the manual-review row must never enter weekCalls at all');
  assert.equal(stats.weekCalls[0].name, 'A Real Call');
  assert.equal(stats.weeklyAvg, 4, 'the blank-audio "1/5" must not drag the average down');
  assert.equal(stats.worstCall.name, 'A Real Call', 'a manual-review-flagged call must never win "worst call of the week"');
  assert.equal(stats.historicCount, 1, 'must not enter the historic average either');
  assert.equal(stats.weekManualReviewFlags.length, 1);
  assert.equal(stats.weekManualReviewFlags[0].name, 'April Stephens');
  assert.equal(stats.weekManualReviewFlags[0].transcriptUrl, 'https://docs.google.com/document/d/xyz/edit');
});

test('callScoreIsUnusableForStats_ flags only the parse-failure sentinel and blank-audio patterns, nothing else', () => {
  assert.equal(gas.callScoreIsUnusableForStats_('Automated scoring failed twice to return parseable JSON; needs manual review.'), true);
  assert.equal(gas.callScoreIsUnusableForStats_('The only thing on this record is "[BLANK_AUDIO]" repeated for the entire call.'), true);
  assert.equal(gas.callScoreIsUnusableForStats_('[blank_audio]'), true, 'case-insensitive');
  assert.equal(gas.callScoreIsUnusableForStats_('Sean asked for the money directly and closed the deal.'), false);
  assert.equal(gas.callScoreIsUnusableForStats_(''), false);
  assert.equal(gas.callScoreIsUnusableForStats_(null), false);
});

test('computeRepWeeklyStats_ does NOT exclude a real, well-graded call just because it was matched fallback_heuristic (Manual Review Recommended forced true, brief.txt §6) — the second, bigger bug found live 04/09/2026 fixing the first one: 467/473 rows in the real sheet carry that flag, and only ~96 are genuinely garbage; the other ~371 (e.g. a real 5/5 close with real quotes) were being wiped from the ENTIRE Weekly Scorecard history, not filtered clean', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 24);
  const weekEnd = bizDate(gas, 2026, 8, 31);
  const rows = [
    // Real case: Meriam Hansen, Sean, 5/5, a genuine detailed close -- fallback_heuristic-matched
    // (Manual Review Recommended forced true per brief.txt §6), NOT a parse failure or blank audio.
    scorecardRow(gas, {
      rep: 'Sean', name: 'Meriam Hansen', date: bizDate(gas, 2026, 8, 26), score: 5,
      feedbackSummary: 'Strong close: Sean asked for the money directly -- "if you can make a decision today, I will give you the 500 bucks off" -- then processed the card live.',
      manualReviewRecommended: true
    })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);

  assert.equal(stats.weekCalls.length, 1, 'a real fallback_heuristic-matched score must still count');
  assert.equal(stats.weekCalls[0].name, 'Meriam Hansen');
  assert.equal(stats.weeklyAvg, 5);
  assert.equal(stats.worstCall.name, 'Meriam Hansen', 'a real 5/5 must be eligible to be the week\'s (only, best) call');
  assert.equal(stats.historicCount, 1);
  assert.equal(stats.weekManualReviewFlags.length, 0, 'must NOT be surfaced as a "needs a new recording" action item -- nothing is wrong with it');
});

test('isSalesCallTypeForScorecard_ excludes QC and Discovery specifically, defaults blank/unrecognized to true', () => {
  assert.equal(gas.isSalesCallTypeForScorecard_('QC'), false);
  assert.equal(gas.isSalesCallTypeForScorecard_('qc'), false, 'case-insensitive');
  assert.equal(gas.isSalesCallTypeForScorecard_('Discovery'), false);
  assert.equal(gas.isSalesCallTypeForScorecard_('Sales Call'), true);
  assert.equal(gas.isSalesCallTypeForScorecard_(''), true, 'blank (older rows predating this column) must not be silently excluded');
  assert.equal(gas.isSalesCallTypeForScorecard_(null), true);
  assert.equal(gas.isSalesCallTypeForScorecard_('Second Sales Call'), true);
});

test('computeRepWeeklyStats_ excludes a QC call from worstCall and every average — real case: Andrew Coppens (2/5, QC, Sean) won "worst call of the week" and was quoted with sales-coaching framing despite being correctly scored under the QC rubric, not the sales one (Tomás\'s comment, 03/09/2026, on Sean\'s Weekly Training Summary: "this a qualification call, it needs to be assessed as [QC], we should separate them for sales calls")', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 24);
  const weekEnd = bizDate(gas, 2026, 8, 31);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'Andrew Coppens', date: bizDate(gas, 2026, 8, 27), score: 2, callType: 'QC', feedbackSummary: 'QC-specific feedback' }),
    scorecardRow(gas, { rep: 'Sean', name: 'A Real Sales Call', date: bizDate(gas, 2026, 8, 27), score: 4, callType: 'Sales Call' })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);

  assert.equal(stats.weekCalls.length, 1, 'the QC row must never enter weekCalls at all');
  assert.equal(stats.weekCalls[0].name, 'A Real Sales Call');
  assert.equal(stats.weeklyAvg, 4, 'the QC score (2) must not drag the sales-call average down');
  assert.equal(stats.worstCall.name, 'A Real Sales Call', 'a lower-scored QC call must never win "worst call of the week" over a real sales call');
  assert.equal(stats.historicCount, 1, 'the QC row must not enter the historic average either');
});

test('computeRepWeeklyStats_ counts this week\'s calls missing an Outcome Disposition', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4, outcomeDisposition: 'Sold' }),
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: bizDate(gas, 2026, 8, 12), score: 2, outcomeDisposition: '' }),
    // Before this week — should not count toward the weekly figure.
    scorecardRow(gas, { rep: 'Sean', name: 'C', date: bizDate(gas, 2026, 8, 3), score: 3, outcomeDisposition: '' })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.weekMissingOutcomeDisposition, 1);
});

test('computeRepWeeklyStats_ averages this week\'s measured call lengths, ignoring rows with no measured length (real ask, 07/09/2026: "Tomas calls are longer than the others — we need to measure the call length and the average")', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const col = Object.assign({}, SCORECARD_COL, { 'Call Length (Minutes)': 13 });
  const row = (name, date, score, callLength) => {
    const r = scorecardRow(gas, { rep: 'Tomás', name, date, score });
    r[12] = callLength; // index 12 = col['Call Length (Minutes)'] - 1
    return r;
  };
  const rows = [
    row('A', bizDate(gas, 2026, 8, 11), 4, 45),
    row('B', bizDate(gas, 2026, 8, 12), 3, 55),
    row('C', bizDate(gas, 2026, 8, 13), 5, '') // no measured length — blank, not 0
  ];
  const stats = gas.computeRepWeeklyStats_(rows, col, 'Tomás', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.weekCallLengthCount, 2, 'the blank-length row must not count toward the measured total');
  assert.equal(stats.weekAvgCallLengthMinutes, 50);
});

test('computeRepWeeklyStats_ reports weekAvgCallLengthMinutes as null (never 0) when no call this week has a measured length', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [scorecardRow(gas, { rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4 })];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.weekAvgCallLengthMinutes, null);
  assert.equal(stats.weekCallLengthCount, 0);
});

test('formatMinutesLabel_ formats under an hour as "Xm" and an hour or more as "Xh Ym"', () => {
  assert.equal(gas.formatMinutesLabel_(42), '42m');
  assert.equal(gas.formatMinutesLabel_(65), '1h 5m');
  assert.equal(gas.formatMinutesLabel_(120), '2h 0m');
});

test('buildCallLengthComparisonEmail_ lists every rep in CALL_LENGTH_COMPARISON_REPS_, including Tomás (not in CONFIG.REPS), with "no data" for a rep with nothing measured', () => {
  const statsByRep = {
    Bens: { weekAvgCallLengthMinutes: 20, weekCallLengthCount: 3 },
    Joana: { weekAvgCallLengthMinutes: 30, weekCallLengthCount: 2 },
    Sean: { weekAvgCallLengthMinutes: null, weekCallLengthCount: 0 },
    'Tomás': { weekAvgCallLengthMinutes: 55, weekCallLengthCount: 4 }
  };
  const email = gas.buildCallLengthComparisonEmail_(statsByRep, '10/08–16/08/2026');
  assert.ok(email.subject.indexOf('Call Length Comparison') !== -1);
  assert.ok(email.body.indexOf('Bens: 20m (3 call(s)') !== -1);
  assert.ok(email.body.indexOf('Tomás: 55m (4 call(s)') !== -1, 'Tomás must be included even though he is not in CONFIG.REPS');
  assert.ok(email.body.indexOf('Sean: no measured call length yet this week') !== -1);
  assert.ok(email.htmlBody.indexOf('<strong>Tom') !== -1);
});

test('computeRepWeeklyStats_ worstCall is null when the rep had no calls this week', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const stats = gas.computeRepWeeklyStats_([], SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.worstCall, null);
});

test('buildWeeklyScorecardEmail_ leads with the task-level quote/priority, pushes the score below the fold', () => {
  const stats = {
    weekCalls: [{ name: 'Jane Doe', score: 2 }],
    weeklyAvg: 2,
    historicAvg: 3,
    historicAvgBeforeThisWeek: 3.2,
    historicCount: 10,
    rolling4WeekAvg: 2.8,
    rolling4WeekCount: 6,
    worstCall: { name: 'Jane Doe', score: 3, feedbackSummary: '"I guess we could talk price" — you let that sit instead of isolating it.' },
    weekFailureModes: ['objections_missed'],
    weekFlagMiss: { askedForClose: 0, objectionsHandled: 1 },
    weekMissingOutcomeDisposition: 1,
    weekManualReviewFlags: []
  };
  const repCfg = { name: 'Sean', email: 'sean@example.com' };
  // buildWeeklyScorecardEmail_ calls Utilities.formatDate purely to render the
  // week-label string — reassigning the sandbox's global Utilities (stubbed
  // to throw by default, see gas_env.js) to a minimal real implementation for
  // just the two format strings this function actually uses.
  gas.Utilities = {
    formatDate: (d, tz, fmt) => {
      const pad = (n) => String(n).padStart(2, '0');
      if (fmt === 'dd/MM') return pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    }
  };
  const email = gas.buildWeeklyScorecardEmail_(repCfg, stats, new gas.Date(2026, 7, 10), new gas.Date(2026, 7, 17), 'UTC');

  const quoteIdx = email.body.indexOf('I guess we could talk price');
  const scoreIdx = email.body.indexOf('2/5');
  const forTheRecordIdx = email.body.indexOf('For the record');
  assert.ok(quoteIdx !== -1, 'expected the worst call\'s quote to appear in the body');
  assert.ok(forTheRecordIdx !== -1, 'expected a "For the record" section');
  assert.ok(quoteIdx < forTheRecordIdx, 'quote should appear before the numeric section');
  assert.ok(scoreIdx > forTheRecordIdx, 'score should appear after the "For the record" marker, not before it');
  assert.ok(email.body.indexOf('Outcome Disposition') > forTheRecordIdx,
    'the outcome-disposition nudge should be a data-hygiene note below the fold, not the lead coaching point');
});

test('buildWeeklyScorecardEmail_ now includes a styled htmlBody with bold labels and a bulleted "For the record" (Kris\'s ask 01/09/2026: this email had no htmlBody at all, unlike every other automated email in this codebase, which is why it read as "poorly formatted and confusing")', () => {
  const stats = {
    weekCalls: [{ name: 'Dave Gove', score: 4 }, { name: 'Jane Doe', score: 2 }],
    weeklyAvg: 3,
    historicAvg: 3,
    historicAvgBeforeThisWeek: 3.2,
    historicCount: 10,
    rolling4WeekAvg: 2.8,
    rolling4WeekCount: 6,
    worstCall: {
      name: 'Jane Doe', score: 3,
      feedbackSummary: '"I guess we could talk price" — you let that sit instead of isolating it.',
      transcriptUrl: 'https://docs.google.com/document/d/abc123/edit',
      recordingUrl: 'https://drive.google.com/file/d/xyz789/view'
    },
    weekFailureModes: ['objections_missed'],
    weekFlagMiss: { askedForClose: 0, objectionsHandled: 1 },
    weekMissingOutcomeDisposition: 1,
    weekManualReviewFlags: []
  };
  const repCfg = { name: 'Sean', email: 'sean@example.com' };
  gas.Utilities = {
    formatDate: (d, tz, fmt) => {
      const pad = (n) => String(n).padStart(2, '0');
      if (fmt === 'dd/MM') return pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    }
  };
  const email = gas.buildWeeklyScorecardEmail_(repCfg, stats, new gas.Date(2026, 7, 10), new gas.Date(2026, 7, 17), 'UTC');

  assert.ok(email.htmlBody, 'expected an htmlBody to be present');
  assert.ok(email.htmlBody.indexOf('<i>&quot;I guess we could talk price&quot;</i>') !== -1,
    'the worst call\'s quoted transcript excerpt must be italicized');
  assert.ok(email.htmlBody.indexOf('<ul') !== -1 && email.htmlBody.indexOf('<li>') !== -1,
    '"For the record" must render as a real bulleted list, not <br>-separated lines');
  assert.ok(email.htmlBody.indexOf('<a href="https://docs.google.com/document/d/abc123/edit"') !== -1,
    'the worst call\'s transcript must be a clickable link');
  assert.ok(email.htmlBody.indexOf('<a href="https://drive.google.com/file/d/xyz789/view"') !== -1,
    'the worst call\'s recording must also be a clickable link (Kris\'s ask 06/09/2026: "always send link to the recording")');
  assert.ok(email.htmlBody.indexOf('Dave Gove') !== -1 && email.htmlBody.indexOf('Jane Doe') !== -1,
    'every this-week call must be listed, not just the worst one');
});

test('buildWeeklyScorecardEmail_ links the recording in plain text too, and says plainly when one couldn\'t be found', () => {
  const stats = {
    weekCalls: [{ name: 'Jane Doe', score: 4 }],
    weeklyAvg: 4, historicAvg: 3, historicAvgBeforeThisWeek: 3, historicCount: 5,
    rolling4WeekAvg: 3, rolling4WeekCount: 5,
    worstCall: { name: 'Jane Doe', score: 4, feedbackSummary: 'Solid call.', transcriptUrl: 'https://docs.google.com/document/d/abc/edit', recordingUrl: 'https://drive.google.com/file/d/vid1/view' },
    weekFailureModes: [], weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }, weekMissingOutcomeDisposition: 0,
    weekManualReviewFlags: []
  };
  gas.Utilities = { formatDate: (d, tz, fmt) => (fmt === 'dd/MM' ? '10/08' : '10/08/2026') };
  const email = gas.buildWeeklyScorecardEmail_({ name: 'Sean', email: 'sean@example.com' }, stats, new gas.Date(2026, 7, 10), new gas.Date(2026, 7, 17), 'UTC');
  assert.ok(email.body.indexOf('Recording: https://drive.google.com/file/d/vid1/view') !== -1);

  const statsNoRecording = Object.assign({}, stats, { worstCall: Object.assign({}, stats.worstCall, { recordingUrl: null }) });
  const email2 = gas.buildWeeklyScorecardEmail_({ name: 'Sean', email: 'sean@example.com' }, statsNoRecording, new gas.Date(2026, 7, 10), new gas.Date(2026, 7, 17), 'UTC');
  assert.ok(email2.body.indexOf('Recording: (recording not found)') !== -1);
});

test('buildWeeklyScorecardEmail_ holds back the AI\'s own feedback quote for a worst call scored under 3, telling the rep Kris will review it personally instead (Kris\'s ask 06/09/2026: "If it\'s under 3 score, I\'ll watch and give feedback" — avoids the rep getting two separate, possibly conflicting reviews of the same call)', () => {
  const stats = {
    weekCalls: [{ name: 'Jane Doe', score: 2 }],
    weeklyAvg: 2, historicAvg: 3, historicAvgBeforeThisWeek: 3.2, historicCount: 10,
    rolling4WeekAvg: 2.8, rolling4WeekCount: 6,
    worstCall: {
      name: 'Jane Doe', score: 2,
      feedbackSummary: '"I guess we could talk price" — you let that sit instead of isolating it.',
      transcriptUrl: 'https://docs.google.com/document/d/abc123/edit',
      recordingUrl: 'https://drive.google.com/file/d/xyz789/view'
    },
    weekFailureModes: ['objections_missed'], weekFlagMiss: { askedForClose: 0, objectionsHandled: 1 },
    weekMissingOutcomeDisposition: 0, weekManualReviewFlags: []
  };
  gas.Utilities = { formatDate: (d, tz, fmt) => (fmt === 'dd/MM' ? '10/08' : '10/08/2026') };
  const email = gas.buildWeeklyScorecardEmail_({ name: 'Sean', email: 'sean@example.com' }, stats, new gas.Date(2026, 7, 10), new gas.Date(2026, 7, 17), 'UTC');

  assert.equal(email.body.indexOf('I guess we could talk price'), -1, 'the AI\'s own quote must not appear for a sub-3 worst call');
  assert.match(email.body, /Kris is watching this one and will follow up directly/);
  assert.ok(email.body.indexOf('Recording: https://drive.google.com/file/d/xyz789/view') !== -1,
    'the recording link must still be sent even when the AI feedback is held back');

  assert.equal(email.htmlBody.indexOf('I guess we could talk price'), -1);
  assert.match(email.htmlBody, /Kris is watching this one and will follow up directly/);
  assert.ok(email.htmlBody.indexOf('<a href="https://drive.google.com/file/d/xyz789/view"') !== -1);
});

test('buildWeeklyScorecardEmail_ surfaces a manual-review-flagged call as an action item (ask for a new recording), never as a score (Kris\'s real complaint, 03/09/2026, April Stephens: a [BLANK_AUDIO] recording failure carried a real-looking "1/5" and could still win "worst call" — computeRepWeeklyStats_ now keeps it out of stats.weekCalls/worstCall entirely; this only ever sees it via weekManualReviewFlags)', () => {
  const stats = {
    weekCalls: [{ name: 'A Real Call', score: 4 }],
    weeklyAvg: 4, historicAvg: 3, historicAvgBeforeThisWeek: 3, historicCount: 5,
    rolling4WeekAvg: 3, rolling4WeekCount: 5,
    worstCall: { name: 'A Real Call', score: 4, feedbackSummary: 'Solid call overall.' },
    weekFailureModes: [], weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }, weekMissingOutcomeDisposition: 0,
    weekManualReviewFlags: [{ name: 'April Stephens', transcriptUrl: '' }]
  };
  const repCfg = { name: 'Joana', email: 'joana@example.com' };
  gas.Utilities = {
    formatDate: (d, tz, fmt) => {
      const pad = (n) => String(n).padStart(2, '0');
      if (fmt === 'dd/MM') return pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    }
  };
  const email = gas.buildWeeklyScorecardEmail_(repCfg, stats, new gas.Date(2026, 7, 24), new gas.Date(2026, 7, 31), 'UTC');

  assert.match(email.body, /flagged (them )?for manual review/i, 'plain-text body must say clearly the AI could not grade this');
  assert.match(email.htmlBody, /flagged (them )?for manual review/i, 'htmlBody must say the same thing clearly');
  assert.match(email.body, /April Stephens/, 'the flagged call must be named so someone can act on it');
  assert.match(email.body, /no transcript on file/, 'a missing transcript must be stated plainly, not silently omitted');
  assert.match(email.htmlBody, /no transcript on file/);
  assert.ok(email.body.indexOf('4/5') !== -1, 'the real scored call must still show its real score');
  assert.equal(email.body.indexOf('1/5'), -1, 'a manual-review-flagged call must never show a numeric score at all');
});

// --- Task: Weekly Training Summary docs (01/09/2026) ---
// Kris's real complaint: Tomás had nothing but a week-old Training Call Plan
// doc to walk into a Tuesday session with, because the Weekly Scorecard
// review of the week's real sales calls only ever existed as an email, never
// a persisted, shareable, nicely-formatted doc the way Training Call Plan is.

test('findQuoteRanges_ finds every "..." quoted excerpt as inclusive-end character offsets, matching DocumentApp.Text.setItalic\'s own convention', () => {
  const text = 'He said "not interested at this point," then later "I have been severely burned in the past."';
  const ranges = gas.findQuoteRanges_(text);
  assert.equal(ranges.length, 2);
  assert.equal(text.slice(ranges[0].start, ranges[0].end + 1), '"not interested at this point,"');
  assert.equal(text.slice(ranges[1].start, ranges[1].end + 1), '"I have been severely burned in the past."');

  assert.equal(gas.findQuoteRanges_('no quotes here at all').length, 0);
  assert.equal(gas.findQuoteRanges_('').length, 0);
});

test('buildWeeklyTrainingSummaryContent_ carries manualReviewFlags through (separately from worstCall, which can never be manual-review-flagged any more) and the worst call\'s transcript link', () => {
  const stats = {
    weekCalls: [{ name: 'Dave Gove', score: 4 }],
    weeklyAvg: 4, historicAvg: 3, historicAvgBeforeThisWeek: 3, historicCount: 5,
    rolling4WeekAvg: 3, rolling4WeekCount: 5,
    worstCall: {
      name: 'Dave Gove', score: 4,
      feedbackSummary: 'Solid call overall.',
      transcriptUrl: 'https://docs.google.com/document/d/abc/edit'
    },
    weekFailureModes: [], weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }, weekMissingOutcomeDisposition: 2,
    weekManualReviewFlags: [{ name: 'April Stephens', transcriptUrl: 'https://docs.google.com/document/d/xyz/edit' }]
  };
  const content = gas.buildWeeklyTrainingSummaryContent_('Joana', stats, '24/08–30/08/2026');
  assert.equal(content.repName, 'Joana');
  assert.equal(content.hasCalls, true);
  assert.equal(content.worstCall.name, 'Dave Gove');
  assert.equal(content.worstCall.transcriptUrl, 'https://docs.google.com/document/d/abc/edit');
  assert.equal(content.worstCall.recordingUrl, ''); // stats.worstCall carried no recordingUrl in this fixture — defaults to '', never undefined
  assert.equal(content.weekCalls.length, 1);
  assert.equal(content.weekMissingOutcomeDisposition, 2);
  assert.equal(content.manualReviewFlags.length, 1);
  assert.equal(content.manualReviewFlags[0].name, 'April Stephens');
  assert.ok(content.priority, 'expected a priority string, even a fallback one');
});

test('buildWeeklyTrainingSummaryContent_ carries the worst call\'s recordingUrl through when set', () => {
  const stats = {
    weekCalls: [{ name: 'Dave Gove', score: 4 }],
    weeklyAvg: 4, historicAvg: 3, historicAvgBeforeThisWeek: 3, historicCount: 5,
    rolling4WeekAvg: 3, rolling4WeekCount: 5,
    worstCall: {
      name: 'Dave Gove', score: 4, feedbackSummary: 'Solid call overall.',
      transcriptUrl: 'https://docs.google.com/document/d/abc/edit',
      recordingUrl: 'https://drive.google.com/file/d/vid1/view'
    },
    weekFailureModes: [], weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }, weekMissingOutcomeDisposition: 0,
    weekManualReviewFlags: []
  };
  const content = gas.buildWeeklyTrainingSummaryContent_('Joana', stats, '24/08–30/08/2026');
  assert.equal(content.worstCall.recordingUrl, 'https://drive.google.com/file/d/vid1/view');
});

test('findRecordingUrlForTranscript_ finds the sibling video in the transcript Doc\'s own parent folder, by stripping the " — Transcript" suffix (matches tools/transcribe_sean_calls.py\'s save_transcript_doc naming convention)', () => {
  const originalDriveApp = gas.DriveApp;
  const fakeVideoFile = { getUrl: () => 'https://drive.google.com/file/d/vid1/view' };
  const fakeFolder = {
    getFilesByName: (name) => {
      const match = name === 'Julio Lopez.mp4';
      let served = false;
      return { hasNext: () => match && !served, next: () => { served = true; return fakeVideoFile; } };
    }
  };
  const fakeTranscriptFile = {
    getName: () => 'Julio Lopez.mp4 — Transcript',
    getParents: () => { let served = false; return { hasNext: () => !served, next: () => { served = true; return fakeFolder; } }; }
  };
  gas.DriveApp = { getFileById: (id) => { assert.equal(id, 'abc123'); return fakeTranscriptFile; } };
  try {
    const url = gas.findRecordingUrlForTranscript_('https://docs.google.com/document/d/abc123/edit');
    assert.equal(url, 'https://drive.google.com/file/d/vid1/view');
  } finally {
    gas.DriveApp = originalDriveApp;
  }
});

test('findRecordingUrlForTranscript_ returns null (never throws) for a blank URL, a URL with no extractable file id, a transcript name with no "— Transcript" suffix, a transcript with no parent folder, or any Drive error', () => {
  const originalDriveApp = gas.DriveApp;
  try {
    assert.equal(gas.findRecordingUrlForTranscript_(''), null);
    assert.equal(gas.findRecordingUrlForTranscript_(null), null);
    assert.equal(gas.findRecordingUrlForTranscript_('not a real url'), null);

    gas.DriveApp = { getFileById: () => ({ getName: () => 'Some Video.mp4' /* no " — Transcript" suffix */ }) };
    assert.equal(gas.findRecordingUrlForTranscript_('https://docs.google.com/document/d/abc123/edit'), null);

    gas.DriveApp = {
      getFileById: () => ({ getName: () => 'Julio Lopez.mp4 — Transcript', getParents: () => ({ hasNext: () => false }) })
    };
    assert.equal(gas.findRecordingUrlForTranscript_('https://docs.google.com/document/d/abc123/edit'), null);

    gas.DriveApp = { getFileById: () => { throw new Error('Drive is down'); } };
    assert.equal(gas.findRecordingUrlForTranscript_('https://docs.google.com/document/d/abc123/edit'), null);
  } finally {
    gas.DriveApp = originalDriveApp;
  }
});

test('buildWeeklyTrainingSummaryContent_ handles no calls this week and no worst call gracefully, without throwing', () => {
  const stats = {
    weekCalls: [], weeklyAvg: null, historicAvg: null, historicAvgBeforeThisWeek: null, historicCount: 0,
    rolling4WeekAvg: null, rolling4WeekCount: 0, worstCall: null,
    weekFailureModes: [], weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }, weekMissingOutcomeDisposition: 0
  };
  const content = gas.buildWeeklyTrainingSummaryContent_('Sean', stats, '24/08–30/08/2026');
  assert.equal(content.hasCalls, false);
  assert.equal(content.worstCall, null);
  assert.equal(content.trendVsPrior, null);
});

test('weeklyTrainingCycleWeekLabel_ reads the week the Tuesday training call kicks off (day after "now"), same as Phase 6\'s trainingCallPlanWeekLabel_', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Tue 25 Aug 2026, same date trainingCallPlanWeekLabel_'s own test uses — must agree: Week 2.
  const now = gas.dateAtMidnightInBusinessTimezone_(2026, 8, 25);
  assert.equal(gas.weeklyTrainingCycleWeekLabel_(now, tz), 'Week 2');
});

test('weeklyTrainingCycleWeekLabel_ returns null when the cycle can\'t be computed (e.g. run manually over a weekend)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Fri 28 Aug 2026 + 1 day = Saturday — no training-cycle day.
  const now = gas.dateAtMidnightInBusinessTimezone_(2026, 8, 28);
  assert.equal(gas.weeklyTrainingCycleWeekLabel_(now, tz), null);
});

test('priorityToImprove_ reports the week\'s most common Primary Failure Mode as a coaching line', () => {
  const stats = {
    weekCalls: [{ name: 'A', score: 4 }, { name: 'B', score: 2 }],
    weekFailureModes: ['no_close_ask', 'no_close_ask'],
    weekFlagMiss: { askedForClose: 2, objectionsHandled: 0 }
  };
  assert.equal(gas.priorityToImprove_(stats), gas.FAILURE_MODE_COACHING_TEXT_.no_close_ask);
});

test('priorityToImprove_ falls back to the Objections Handled flag when no Primary Failure Mode data exists', () => {
  const stats = {
    weekCalls: [{ name: 'A', score: 3 }],
    weekFailureModes: [],
    weekFlagMiss: { askedForClose: 1, objectionsHandled: 2 }
  };
  assert.equal(gas.priorityToImprove_(stats), gas.FAILURE_MODE_COACHING_TEXT_.objections_missed);
});

test('priorityToImprove_ returns null when the rep had no calls scored this week', () => {
  assert.equal(gas.priorityToImprove_({ weekCalls: [], weekFailureModes: [], weekFlagMiss: {} }), null);
});

test('priorityToImprove_ reports the framework-explanation coaching line when that\'s the week\'s most common failure mode', () => {
  const stats = {
    weekCalls: [{ name: 'A', score: 4 }, { name: 'B', score: 3 }],
    weekFailureModes: ['framework_not_explained', 'framework_not_explained'],
    weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }
  };
  assert.equal(gas.priorityToImprove_(stats), gas.FAILURE_MODE_COACHING_TEXT_.framework_not_explained);
});

test('priorityToImprove_ reports real delivery coaching text, not the generic "Focus area: delivery_ineffective" fallback, when that\'s the week\'s most common failure mode (29/08/2026 — closes the gap left when the delivery dimension shipped without a FAILURE_MODE_COACHING_TEXT_ entry)', () => {
  const stats = {
    weekCalls: [{ name: 'A', score: 4 }, { name: 'B', score: 3 }],
    weekFailureModes: ['delivery_ineffective', 'delivery_ineffective'],
    weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }
  };
  const result = gas.priorityToImprove_(stats);
  assert.equal(result, gas.FAILURE_MODE_COACHING_TEXT_.delivery_ineffective);
  assert.ok(result.indexOf('Focus area:') === -1, 'must be real coaching text, not the generic unrecognized-value fallback');
});

test('isValidDailyPracticeSchema_ accepts "framework" as a drill_type and requires framework_topic', () => {
  const good = {
    drill_type: 'framework',
    objection_type: 'n/a',
    framework_topic: 'recruit_agents',
    technique_used: true,
    delivery_quality: 'confident',
    overall_score: 4,
    sharpen_next: 'string',
    feedback_summary: 'string'
  };
  assert.equal(gas.isValidDailyPracticeSchema_(good), true);
  assert.equal(gas.isValidDailyPracticeSchema_(Object.assign({}, good, { framework_topic: undefined })), false);
  assert.equal(gas.isValidDailyPracticeSchema_(Object.assign({}, good, { drill_type: 'not_a_real_type' })), false);
});

function fakeThread(messages) {
  return {
    getMessages: () => messages.map((m) => ({ getFrom: () => m.from, getPlainBody: () => m.body }))
  };
}

test('dailyPracticeThreadHasStopRequest_ ignores the bot\'s own nag message even though it is sent from Kris\'s own account and contains "cancel"/"stop" (real bug C-03: GAS sends as the script owner, so the very first automated nag would self-cancel the thread)', () => {
  const botsOwnNag = fakeThread([
    { from: 'Daily Practice Follow-up Bot <kris@iconsofrealestate.com>', body: 'This thread will keep getting a nag until the file lands, or Kris or Tomás replies-all here with "cancel" or "stop".' }
  ]);
  assert.equal(gas.dailyPracticeThreadHasStopRequest_(botsOwnNag), false);

  const realStopFromKris = fakeThread([
    { from: 'Daily Practice Follow-up Bot <kris@iconsofrealestate.com>', body: 'nag body mentioning cancel/stop' },
    { from: 'Kris <kris@iconsofrealestate.com>', body: 'please stop, rep is out sick' }
  ]);
  assert.equal(gas.dailyPracticeThreadHasStopRequest_(realStopFromKris), true);

  const repSayingDone = fakeThread([
    { from: 'Sean <sean@iconsofrealestate.com>', body: 'done, uploaded, please stop' }
  ]);
  assert.equal(gas.dailyPracticeThreadHasStopRequest_(repSayingDone), false, 'only Kris/Tomás can cancel, not the rep');
});

// --- Bens rubric: directly-booked Sales Call outranks a QC-only booking (25/08/2026, Kris) ---
test('buildBensJudgeSystemPrompt_ scores a directly-booked Sales Call higher than a QC-only booking for an interview', () => {
  const prompt = gas.buildBensJudgeSystemPrompt_();
  // Guards against a future edit silently dropping this nuance — the underlying
  // next_step_type field was already scored, only the weighting was missing.
  assert.match(prompt, /directly-booked SALES CALL is the strongest/);
  assert.match(prompt, /was only a QC rather than a Sales Call directly/);
  // Must be scoped to the interview role, not the qc role, whose only
  // meaningful next step is already a Sales Call.
  assert.match(prompt, /does not apply to a qc call/);
});

// --- Regression drift check: gate on rubric version, don't confuse a rubric
// change for real model drift (bug found live 25/08/2026 — see the comment
// on rubricChangedSinceFreeze_ in Phase2_CallScoring.gs for the real
// incident: 8 of 9 rows in an actual run "drifted" purely because the
// rubric had changed since the baseline was frozen, not because the model
// behaved inconsistently) ---
test('rubricChangedSinceFreeze_ flags a mismatch and treats a blank frozen version as a mismatch', () => {
  assert.equal(gas.rubricChangedSinceFreeze_('2026-08-25-framework', '2026-08-25-framework'), false);
  assert.equal(gas.rubricChangedSinceFreeze_('2026-08-25-framework', '2026-08-25-bens-sales-call-over-qc'), true);
  // A baseline frozen before RUBRIC_VERSION existed has no frozen version at
  // all — conservative default is "can't confirm it matches," not "assume it does."
  assert.equal(gas.rubricChangedSinceFreeze_('', '2026-08-25-framework'), true);
  assert.equal(gas.rubricChangedSinceFreeze_(undefined, '2026-08-25-framework'), true);
});

// --- Task: RUBRIC_VERSION column (25/08/2026) ---

test('RUBRIC_VERSION is a non-empty date-prefixed string, per the versioning convention documented alongside it', () => {
  assert.equal(typeof gas.RUBRIC_VERSION, 'string');
  assert.ok(gas.RUBRIC_VERSION.length > 0);
  assert.match(gas.RUBRIC_VERSION, /^\d{4}-\d{2}-\d{2}-/);
});

test('rescoreAllCalls_ in last-week-only mode rescores just the week the training picker reads, leaving every older row untouched (Kris 03/09/2026: 470 rows at ~2.5min each to fix the 16 calls that week actually contains)', () => {
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const headers = gas.SALES_CALL_LOG_HEADERS;
  const col = {};
  headers.forEach((h, i) => { col[h] = i + 1; });

  // getWeekBounds_ is the single source of truth for "last week" shared with
  // the playbook picker and the weekly scorecard — derive the fixture dates
  // from it rather than hardcoding, so the two can never drift apart.
  // Dates must be built with the SANDBOX's Date constructor: the product code
  // guards with `instanceof Date` (same as buildAndMaybeSendPlaybookReview_),
  // and a Node-realm Date fails that check inside the vm even though a real
  // sheet cell would pass it — the same cross-realm trap documented on
  // assert.deepEqual elsewhere in this file.
  const week = gas.getWeekBounds_(new gas.Date(), tz);
  const inWeek = new gas.Date(week.start.getTime() + 24 * 3600 * 1000);
  const longAgo = new gas.Date(week.start.getTime() - 60 * 24 * 3600 * 1000);

  const row = (name, date) => {
    const r = new Array(headers.length).fill('');
    r[col['Prospect Name'] - 1] = name;
    r[col['Call Date'] - 1] = date;
    r[col['Rep'] - 1] = 'Sean';
    r[col['Call Type'] - 1] = 'Sales Call';
    r[col['Call Quality Score'] - 1] = 3;
    r[col['Transcript URL'] - 1] = 'https://docs.google.com/document/d/x/edit';
    r[col['Rubric Version'] - 1] = '2026-08-29-pitch-delivery'; // stale, so eligible
    return r;
  };
  const values = [row('In Window', inWeek), row('Two Months Ago', longAgo)];

  const fakeSheet = {
    getLastRow: () => values.length + 1,
    getSheetId: () => 1,
    getName: () => 'Sales Call Log',
    getRange(startRow, startCol, numRows) {
      if (startRow === 1) return { getValues: () => [headers.slice()] };
      return { getValues: () => values.slice(startRow - 2, startRow - 2 + numRows) };
    }
  };

  const originals = { log: gas.log_, ss: gas.SpreadsheetApp, lock: gas.LockService, ut: gas.Utilities };
  const logged = [];
  gas.log_ = (m) => logged.push(String(m));
  gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: (n) => (n === 'Sales Call Log' ? fakeSheet : null), getSheets: () => [fakeSheet] }) };
  gas.Utilities = { formatDate: realFormatDate, sleep() {} };
  try {
    // Dry run: exercises the whole eligibility/scoping path with no model calls.
    gas.rescoreAllCalls_(true, /*lastWeekOnly=*/true);
    const all = logged.join('\n');
    assert.ok(/In Window/.test(all), 'a call inside last week must be picked up');
    assert.ok(!/Two Months Ago/.test(all), 'a call outside last week must not be rescored in scoped mode');
    assert.ok(/1 row\(s\) outside it untouched/.test(all),
      'the log must say how many rows were left alone, so the saving is visible');

    // Real confusion caused live (08/09/2026), Kris looking at scoped
    // output: "There aren't 454 calls last week?" — 454 was values.length,
    // the WHOLE SHEET's all-time row count, standing in as the denominator
    // for a message that read like it described the scoped week. The
    // scoped population here is 1 (In Window only; Two Months Ago is
    // outside it), and that — not the sheet's total row count of 2 — must
    // be what "out of N" reports.
    assert.ok(/1 row\(s\) out of 1 call\(s\) that week need a rescore this pass/.test(all),
      'the "out of N" denominator must be the scoped week\'s population, not the whole sheet\'s row count');

    // Unscoped mode is unchanged — both rows are still eligible, and reports
    // against the sheet-wide count instead (this is deliberately not a
    // "week" in that mode, so it's worded as rows, not calls-that-week).
    logged.length = 0;
    gas.rescoreAllCalls_(true, /*lastWeekOnly=*/false);
    const unscoped = logged.join('\n');
    assert.ok(/In Window/.test(unscoped) && /Two Months Ago/.test(unscoped),
      'the unscoped rescore must still cover all of history');
    assert.ok(/2 row\(s\) out of 2 row\(s\) in the sheet need a rescore this pass/.test(unscoped));
  } finally {
    gas.log_ = originals.log;
    gas.SpreadsheetApp = originals.ss;
    gas.LockService = originals.lock;
    gas.Utilities = originals.ut;
  }
});

test('rescoreScopeWindow_ resolves each of its three modes correctly (Kris 09/09/2026: "Can we review the last month...")', () => {
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const now = new gas.Date('2026-09-09T12:00:00.000Z');

  // true -> unchanged, the last completed Mon-Sun week.
  const week = gas.rescoreScopeWindow_(true, now, tz);
  assert.deepEqual(week, gas.getWeekBounds_(now, tz));

  // a positive number -> that many days back from now, ending now.
  const days = gas.rescoreScopeWindow_(30, now, tz);
  assert.equal(days.end.getTime(), now.getTime());
  assert.equal(days.start.getTime(), now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // anything else -> no window at all.
  assert.equal(gas.rescoreScopeWindow_(false, now, tz), null);
  assert.equal(gas.rescoreScopeWindow_(undefined, now, tz), null);
  assert.equal(gas.rescoreScopeWindow_(0, now, tz), null);
});

test('rescoreAllCalls_ in a day-count window rescores the last month, with its own log label distinct from the week mode', () => {
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const headers = gas.SALES_CALL_LOG_HEADERS;
  const col = {};
  headers.forEach((h, i) => { col[h] = i + 1; });

  const now = new gas.Date();
  const inWindow = new gas.Date(now.getTime() - 10 * 24 * 3600 * 1000); // 10 days ago
  const outsideWindow = new gas.Date(now.getTime() - 60 * 24 * 3600 * 1000); // 60 days ago

  const row = (name, date) => {
    const r = new Array(headers.length).fill('');
    r[col['Prospect Name'] - 1] = name;
    r[col['Call Date'] - 1] = date;
    r[col['Rep'] - 1] = 'Bens';
    r[col['Call Type'] - 1] = 'Icons 100 Recording';
    r[col['Call Quality Score'] - 1] = 3;
    r[col['Transcript URL'] - 1] = 'https://drive.google.com/file/d/x/view';
    r[col['Rubric Version'] - 1] = '2026-08-29-pitch-delivery'; // stale, so eligible
    return r;
  };
  const values = [row('Inside The Month', inWindow), row('Two Months Ago', outsideWindow)];

  const fakeSheet = {
    getLastRow: () => values.length + 1,
    getSheetId: () => 1,
    getName: () => 'Sales Call Log',
    getRange(startRow, startCol, numRows) {
      if (startRow === 1) return { getValues: () => [headers.slice()] };
      return { getValues: () => values.slice(startRow - 2, startRow - 2 + numRows) };
    }
  };

  const originals = { log: gas.log_, ss: gas.SpreadsheetApp, lock: gas.LockService, ut: gas.Utilities };
  const logged = [];
  gas.log_ = (m) => logged.push(String(m));
  gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: (n) => (n === 'Sales Call Log' ? fakeSheet : null), getSheets: () => [fakeSheet] }) };
  gas.Utilities = { formatDate: realFormatDate, sleep() {} };
  try {
    gas.rescoreAllCalls_(true, /*lastWeekOnly=*/30);
    const all = logged.join('\n');
    assert.ok(/Inside The Month/.test(all), 'a call inside the 30-day window must be picked up');
    assert.ok(!/Two Months Ago/.test(all), 'a call outside the 30-day window must not be rescored');
    assert.ok(/previewRescoreLast30DaysCalls/.test(all), 'the day-window mode gets its own log label, distinct from LastWeekCalls');
    assert.ok(/1 row\(s\) out of 1 call\(s\) in that window need a rescore this pass/.test(all));
  } finally {
    gas.log_ = originals.log;
    gas.SpreadsheetApp = originals.ss;
    gas.LockService = originals.lock;
    gas.Utilities = originals.ut;
  }
});

test('rescoreAllCalls_ repFilter scopes a rescore to one rep, mirroring buildAndMaybeSendPlaybookReview_\'s repNameFilter (Kris 09/09/2026: "YES just Bens" + "And make it just 2 weeks")', () => {
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const headers = gas.SALES_CALL_LOG_HEADERS;
  const col = {};
  headers.forEach((h, i) => { col[h] = i + 1; });

  const now = new gas.Date();
  const inWindow = new gas.Date(now.getTime() - 5 * 24 * 3600 * 1000); // 5 days ago, inside a 14-day window

  const row = (name, rep, callType) => {
    const r = new Array(headers.length).fill('');
    r[col['Prospect Name'] - 1] = name;
    r[col['Call Date'] - 1] = inWindow;
    r[col['Rep'] - 1] = rep;
    r[col['Call Type'] - 1] = callType;
    r[col['Call Quality Score'] - 1] = 3;
    r[col['Transcript URL'] - 1] = 'https://drive.google.com/file/d/x/view';
    r[col['Rubric Version'] - 1] = '2026-08-29-pitch-delivery'; // stale, so eligible
    return r;
  };
  const values = [
    row('Bens Interviewee', 'BENS', 'Icons 100 Recording'), // different case than the filter, on purpose
    row('Seans Prospect', 'Sean', 'Sales Call'),
  ];

  const fakeSheet = {
    getLastRow: () => values.length + 1,
    getSheetId: () => 1,
    getName: () => 'Sales Call Log',
    getRange(startRow, startCol, numRows) {
      if (startRow === 1) return { getValues: () => [headers.slice()] };
      return { getValues: () => values.slice(startRow - 2, startRow - 2 + numRows) };
    }
  };

  const originals = { log: gas.log_, ss: gas.SpreadsheetApp, lock: gas.LockService, ut: gas.Utilities };
  const logged = [];
  gas.log_ = (m) => logged.push(String(m));
  gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: (n) => (n === 'Sales Call Log' ? fakeSheet : null), getSheets: () => [fakeSheet] }) };
  gas.Utilities = { formatDate: realFormatDate, sleep() {} };
  try {
    // 'Bens' matches the sheet's own 'Bens' case-insensitively, same as
    // repNameFilter's own comparison in buildAndMaybeSendPlaybookReview_ —
    // exercised here by passing the filter in a different case than the row.
    gas.rescoreAllCalls_(true, /*lastWeekOnly=*/14, /*repFilter=*/'Bens');
    const all = logged.join('\n');
    assert.ok(/Bens Interviewee/.test(all), 'Bens\'s own row inside the window must still be picked up');
    assert.ok(!/Seans Prospect/.test(all), 'a row for a different rep must be filtered out even though it is inside the window');
    assert.ok(/previewRescoreLast14DaysCallsForBens/.test(all), 'the rep-filtered mode gets its own distinct log label');
    assert.ok(/1 row\(s\) out of 1 call\(s\) in that window for Bens need a rescore this pass/.test(all));
  } finally {
    gas.log_ = originals.log;
    gas.SpreadsheetApp = originals.ss;
    gas.LockService = originals.lock;
    gas.Utilities = originals.ut;
  }
});

test('writeScoreToRow_ writes the current RUBRIC_VERSION into the Rubric Version column', () => {
  // Minimal fake sheet: getRange(row, col).setValue(v) records into a plain
  // map keyed "row:col" — writeScoreToRow_ only ever calls getRange/setValue,
  // nothing else, so this is enough to exercise it without a live sheet.
  const cells = {};
  const fakeSheet = {
    getRange(row, col) {
      return { setValue(v) { cells[row + ':' + col] = v; return this; } };
    }
  };
  // Real column layout, so this test breaks (loudly) if SALES_CALL_LOG_HEADERS
  // and writeScoreToRow_ ever drift apart on a key it relies on.
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });

  const result = {
    lead_quality: { verdict: 'good_to_book' },
    call_quality_score: 4,
    flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: false },
    manual_review_recommended: false,
    severity: 1,
    feedback_summary: 'string',
    primary_failure_mode: 'none'
  };
  gas.writeScoreToRow_(fakeSheet, 7, col, result, false);

  assert.equal(cells['7:' + col['Rubric Version']], gas.RUBRIC_VERSION);
  assert.equal(cells['7:' + col['Flag: Delivery Effective']], false, '29/08/2026: one delivery gap must fail the overall Flag: Delivery Effective column');
  assert.equal(cells['7:' + col['Delivery Gaps']], 'reading and adapting to the lead\'s engagement');
  assert.equal(cells['7:' + col['Call Length (Minutes)']], '', 'no callLengthMinutes argument given must write blank, never a fabricated 0');
});

test('writeScoreToRow_ writes the given callLengthMinutes into the Call Length (Minutes) column', () => {
  const cells = {};
  const fakeSheet = { getRange(row, col) { return { setValue(v) { cells[row + ':' + col] = v; return this; } }; } };
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const result = {
    lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
    flags: { asked_for_close: true, objections_uncovered: false, objections_overcome: false },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
    manual_review_recommended: false, severity: 1, feedback_summary: 'x', primary_failure_mode: 'none'
  };
  gas.writeScoreToRow_(fakeSheet, 7, col, result, false, 'Prospect', 'shared', 42.5);
  assert.equal(cells['7:' + col['Call Length (Minutes)']], 42.5);
});

test('extractCallLengthMinutes_ parses the leading "[Call length: MM:SS]" line tools/transcribe_sean_calls.py stashes at the top of a transcript', () => {
  assert.equal(gas.extractCallLengthMinutes_('[Call length: 42:30]\n\nHey, thanks for hopping on...'), 42.5);
  assert.equal(gas.extractCallLengthMinutes_('[Call length: 5:00]\n\nHi'), 5);
});

test('extractCallLengthMinutes_ returns null (never a fabricated 0) when the line is missing — an older transcript, or one from a source that never routed through run_whisper_batch', () => {
  assert.equal(gas.extractCallLengthMinutes_('Hey, thanks for hopping on...'), null);
  assert.equal(gas.extractCallLengthMinutes_(''), null);
  assert.equal(gas.extractCallLengthMinutes_(undefined), null);
});

test('stripLeadingCallLengthLine_ removes only the leading call-length line, leaving the rest of the transcript untouched', () => {
  const stripped = gas.stripLeadingCallLengthLine_('[Call length: 12:05]\n\nHey, thanks for hopping on the call today.');
  assert.equal(stripped, 'Hey, thanks for hopping on the call today.');
});

test('stripLeadingCallLengthLine_ is a no-op on a transcript that never had the line (nothing to confuse it into stripping real content)', () => {
  const text = 'Hey, thanks for hopping on the call today.';
  assert.equal(gas.stripLeadingCallLengthLine_(text), text);
});

test('getTranscriptText_ strips the call-length line before returning transcript text, so it can never leak into a judge prompt as something someone said on the call', () => {
  const fakeFile = {
    getName: () => 'Fake Prospect.mp4 — Transcript',
    getMimeType: () => 'text/plain',
    getBlob: () => ({ getDataAsString: () => '[Call length: 30:00]\n\nReal transcript content here.' })
  };
  assert.equal(gas.getTranscriptText_(fakeFile), 'Real transcript content here.');
});

test('getCallLengthMinutesFromTranscriptFile_ reads the same file\'s raw text independently of getTranscriptText_, so the number survives even though getTranscriptText_ strips it', () => {
  const fakeFile = {
    getName: () => 'Fake Prospect.mp4 — Transcript',
    getMimeType: () => 'text/plain',
    getBlob: () => ({ getDataAsString: () => '[Call length: 18:15]\n\nReal transcript content here.' })
  };
  assert.equal(gas.getCallLengthMinutesFromTranscriptFile_(fakeFile), 18.3);
});

// --- Task: prefer Zoom's transcript over our own (Kris, Sean training call 08/09/2026) ---

/** Folder fake with the getFiles()/getFolders() surface getFilesRecursive_ actually walks. */
function fakeDriveFolder(fileNames, subfolders) {
  const files = fileNames.map((name) => ({ getName: () => name }));
  const subs = subfolders || [];
  return {
    getFiles: () => {
      let i = 0;
      return { hasNext: () => i < files.length, next: () => files[i++] };
    },
    getFolders: () => {
      let i = 0;
      return { hasNext: () => i < subs.length, next: () => subs[i++] };
    }
  };
}

test('transcriptCallKey_ collapses Zoom\'s .vtt and our own "— Transcript" Doc for the same call onto one key, so the two can be recognised as duplicates despite coming from different tools', () => {
  assert.equal(
    gas.transcriptCallKey_('1/21 Anthony Camperi.mp4 — Transcript'),
    gas.transcriptCallKey_('1/21 Anthony Camperi.transcript.vtt')
  );
  assert.equal(
    gas.transcriptCallKey_('Frank Pirrone — Transcript'),
    gas.transcriptCallKey_('Frank Pirrone.vtt')
  );
  // Different calls must NOT collapse — the whole mechanism is a skip, so a
  // false match would silently drop a real call from scoring.
  assert.notEqual(
    gas.transcriptCallKey_('Frank Pirrone — Transcript'),
    gas.transcriptCallKey_('Stuart Ramirez.vtt')
  );
});

test('looksLikeScorableTranscriptFile_ accepts Zoom\'s lowercase ".transcript.vtt" — the old `indexOf(\'Transcript\')` guard was case-SENSITIVE, so every Zoom transcript was invisible to all six folder scanners', () => {
  assert.equal(gas.looksLikeScorableTranscriptFile_('GMT20260908-140000_Recording.transcript.vtt'), true);
  assert.equal(gas.looksLikeScorableTranscriptFile_('Frank Pirrone.mp4 — Transcript'), true);
  assert.equal(gas.looksLikeScorableTranscriptFile_('Frank Pirrone.mp4'), false);
});

test('ourTranscriptIsSupersededByZoom_ skips our own Doc when a Zoom .vtt for the same call exists, keeps it when none does, and never skips the .vtt itself', () => {
  const index = { [gas.transcriptCallKey_('Frank Pirrone.vtt')]: true };
  assert.equal(gas.ourTranscriptIsSupersededByZoom_('Frank Pirrone.mp4 — Transcript', index), true);
  assert.equal(gas.ourTranscriptIsSupersededByZoom_('Frank Pirrone.vtt', index), false);
  assert.equal(gas.ourTranscriptIsSupersededByZoom_('Stuart Ramirez.mp4 — Transcript', index), false);
  assert.equal(gas.ourTranscriptIsSupersededByZoom_('Frank Pirrone.mp4 — Transcript', {}), false);
});

test('transcriptProspectNameFromFileName_ leaves the Doc branch byte-for-byte what every scorer already did inline (dedup keys and existing rows must not shift), and strips Zoom\'s suffixes on the .vtt branch', () => {
  assert.equal(gas.transcriptProspectNameFromFileName_('1/21 Anthony Camperi.mp4 — Transcript'), '1/21 Anthony Camperi.mp4');
  assert.equal(gas.transcriptProspectNameFromFileName_('Frank Pirrone - Transcript'), 'Frank Pirrone');
  assert.equal(gas.transcriptProspectNameFromFileName_('Frank Pirrone.transcript.vtt'), 'Frank Pirrone');
  assert.equal(gas.transcriptProspectNameFromFileName_('Frank Pirrone.vtt'), 'Frank Pirrone');
});

test('indexZoomTranscriptCallKeys_ walks subfolders too (reps move old calls into dated subfolders — the same reason getFilesRecursive_ exists) and indexes only .vtt files', () => {
  const folder = fakeDriveFolder(
    ['Frank Pirrone.mp4', 'Frank Pirrone.mp4 — Transcript'],
    [fakeDriveFolder(['Stuart Ramirez.transcript.vtt'], [])]
  );
  const index = gas.indexZoomTranscriptCallKeys_(folder);
  assert.equal(Object.keys(index).length, 1);
  assert.equal(index[gas.transcriptCallKey_('Stuart Ramirez.vtt')], true);
});

test('vttToPlainText_ strips the WEBVTT header, cue numbers, timestamps and inline cue tags, and collapses the consecutive duplicate lines Zoom emits while a caption stays on screen', () => {
  const vtt = [
    'WEBVTT',
    '',
    'NOTE recorded by Zoom',
    '',
    '1',
    '00:00:01.000 --> 00:00:04.000',
    '<v Sean>Sean: Hey Frank, thanks for jumping on.',
    '',
    '2',
    '00:00:04.000 --> 00:00:06.500',
    'Sean: Hey Frank, thanks for jumping on.',
    '',
    '3',
    '00:00:06.500 --> 00:00:09.000',
    'Frank: No problem at all.'
  ].join('\n');
  assert.equal(
    gas.vttToPlainText_(vtt),
    'Sean: Hey Frank, thanks for jumping on.\nFrank: No problem at all.'
  );
});

test('vttDurationMinutes_ reads the call length off the last cue\'s end timestamp, so a Zoom-sourced row still fills the "Call Length (Minutes)" column Kris called a key indicator — and returns null (never a fabricated 0) when nothing parses', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHi.\n\n2\n00:31:10.000 --> 00:32:30.000\nBye.';
  assert.equal(gas.vttDurationMinutes_(vtt), 32.5);
  assert.equal(gas.vttDurationMinutes_('WEBVTT\n\nnothing here'), null);
  // MM:SS.mmm cues (no hours component) are legal WebVTT too.
  assert.equal(gas.vttDurationMinutes_('WEBVTT\n\n1\n00:10.000 --> 09:00.000\nHi.'), 9);
});

test('readRawTranscriptFileText_ routes a Zoom .vtt through the WebVTT parser, so cue numbers and timestamps can never reach a judge prompt as if someone had said them', () => {
  const vttFile = {
    getName: () => 'Frank Pirrone.transcript.vtt',
    getMimeType: () => 'text/vtt',
    getBlob: () => ({ getDataAsString: () => 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nSean: Hello there.' })
  };
  assert.equal(gas.readRawTranscriptFileText_(vttFile), 'Sean: Hello there.');
  assert.equal(gas.getCallLengthMinutesFromTranscriptFile_(vttFile), 0.1);
});

// --- Task: catch repetition-loop corrupted transcripts (Tomás, 08/09/2026: "3,933 times") ---

test('transcriptUnusableReason_ catches the repetition loop that made Frank Pirrone score 1/5 — half a page of real call followed by one line thousands of times, which sails straight past the word floor', () => {
  const real = [
    'Sean: Hey Frank, thanks for jumping on today.',
    'Frank: Happy to be here, I have been looking at this for a while.',
    'Sean: Tell me what made you book the call in the first place.',
    'Frank: Honestly I want more visibility, nobody in my market knows who I am.',
    'Sean: Got it. And how many transactions did you close last year?',
    'Frank: About eighteen, but almost all of them came from my brokerage.'
  ].join('\n');
  const loop = new Array(400).fill('Frank: I am going to do it this way.').join('\n');
  assert.equal(gas.transcriptUnusableReason_(real + '\n' + loop), 'repetition_loop');
  // Long enough to pass the word floor, so this is genuinely the new check
  // firing and not the old one.
  assert.equal(real.split(/\s+/).length > gas.UNUSABLE_TRANSCRIPT_MIN_WORDS_, true);
});

test('transcriptIsDegenerateRepetition_ catches the ACTUAL Frank Pirrone transcript shape — real bug found 09/09/2026, the SAME DAY the line-based version of this check shipped: Kris pasted the real Google Doc and it has almost no line breaks at all. The corrupted tail is one unbroken run of "I\'m going to do it this way." glued together with plain spaces, no delimiter of any kind — a line-based check sees ~2 "lines" total and does nothing', () => {
  const opening = 'Hi Sean. >> Hi Frank. Good morning. >> Good morning. >> I am trying to dial into Zoom on my ' +
    'computer that has audio, so I was not blowing you off. >> Yeah, yeah, it is better so you can see the ' +
    'slides clearly. >> Gotcha, let me try that now, one second please, thank you. >> Take your time Frank, ' +
    'no worries, we have got all day for this. >> I appreciate that, let me just find the right link here.';
  // No newlines anywhere, matching the real doc exactly — this is the whole point of the regression.
  const corruptedTail = new Array(3933).fill("I'm going to do it this way.").join(' ');
  const full = opening + ' ' + corruptedTail;
  assert.equal(full.indexOf('\n'), -1, 'the real corruption has zero line breaks — this must not rely on them');
  assert.equal(gas.transcriptIsDegenerateRepetition_(full), true);
  assert.equal(gas.transcriptUnusableReason_(full), 'repetition_loop');
});

test('transcriptUnusableReason_ leaves a real call alone, including a short one where the rep says "yeah" and "right" over and over — deliberately adversarial for the word-n-gram check: strict alternation lands at 37.5% dominant-window share, comfortably under the 50% threshold but with real margin tested, not just assumed', () => {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push('Rep: Yeah.');
    lines.push('Rep: Right.');
    lines.push('Lead: So my situation is a little different from that, number ' + i + '.');
  }
  const text = lines.join('\n');
  assert.equal(gas.transcriptUnusableReason_(text), null);
  assert.ok(gas.transcriptRepetitionLoopShare_(text) < 0.5);
});

test('transcriptRepetitionLoopShare_ requires BOTH a long transcript and a real dominant window — a short transcript with one coincidentally-repeated 6-word phrase must not trip on word count alone', () => {
  // Under the 150-word floor even though the repeat itself looks bad in isolation.
  const short = 'Rep: thanks for taking the call today. ' + 'Rep: thanks for taking the call today. '.repeat(5);
  assert.equal(gas.transcriptRepetitionLoopShare_(short), 0);
});

test('transcriptUnusableReason_ still separates the three original failure modes, so the row can say which one it was — a rep told only "unusable" cannot tell whether to re-upload or wait for a re-transcription', () => {
  assert.equal(gas.transcriptUnusableReason_(''), 'empty');
  assert.equal(gas.transcriptUnusableReason_('[BLANK_AUDIO] [BLANK_AUDIO]'), 'blank_audio');
  assert.equal(gas.transcriptUnusableReason_('Hi there, this is Sean.'), 'too_short');
});

test('unusableTranscriptResult_(\'repetition_loop\') writes a BLANK score with no flags and tells the rep to upload the Zoom transcript, and Phase5 excludes it from every stat', () => {
  const result = gas.unusableTranscriptResult_('repetition_loop');
  assert.equal(result.call_quality_score, '');
  assert.deepEqual(Object.assign({}, result.flags), {});
  assert.match(result.feedback_summary, /Zoom transcript/);
  assert.match(result.feedback_summary, /NOT a reflection of the rep/);
  assert.equal(gas.callScoreIsUnusableForStats_(result.feedback_summary), true);
  // And the pre-existing modes keep their own wording and exclusion.
  assert.equal(gas.callScoreIsUnusableForStats_(gas.unusableTranscriptResult_('blank_audio').feedback_summary), true);
});

// --- Task: frozen regression set / drift detection (25/08/2026) ---

test('rubricVariantForNewScore_ gives every rep their OWN rubric for a new score, so Bens is never graded on a closer\'s framework/money-ask again (real bug 03/09/2026: his framework failed 4 of 4 calls on a rubric written for somebody else\'s job)', () => {
  // Kris, 26/08/2026: Bens "runs ICONS 100 lead-gen interviews and QCs ... and
  // never asks for money or explains the framework himself."
  assert.equal(gas.rubricVariantForNewScore_('Bens', 'Sales Call'), 'bens');
  assert.equal(gas.rubricVariantForNewScore_('Sean', 'Sales Call'), 'sean');
  assert.equal(gas.rubricVariantForNewScore_('Tomás', 'Sales Call'), 'tomas');
  assert.equal(gas.rubricVariantForNewScore_('Joana', 'Sales Call'), 'shared',
    'Joana has no dedicated variant and legitimately uses the shared closer rubric');

  // Call type still wins over rep — a QC is never a closing call whoever ran it.
  assert.equal(gas.rubricVariantForNewScore_('Bens', 'QC'), 'qc');
  assert.equal(gas.rubricVariantForNewScore_('Tomás', 'QC'), 'qc');

  // Real bug found live (03/09/2026, Kris: "Discovery calls are totally
  // different!"): a Discovery call (the account manager's post-sale
  // onboarding/payment call) used to route to the QC rubric too — built
  // entirely around qualification-questioning quality, nothing about money
  // collection or elevating the AM. Split into its own dedicated variant.
  assert.equal(gas.rubricVariantForNewScore_('Sean', 'Discovery'), 'discovery');
  assert.equal(gas.rubricVariantForNewScore_('Bens', 'Discovery'), 'discovery');
});

test('resolveRubricVariantForRow_ still reports HISTORY, not what should score a call — rows the ongoing pipeline scored before 03/09/2026 really were scored by the shared rubric, and checkRegressionDrift_ depends on knowing that', () => {
  assert.equal(gas.resolveRubricVariantForRow_('Sean', 'exact_key'), 'shared');
  assert.equal(gas.resolveRubricVariantForRow_('Bens', 'exact_key'), 'shared');
  assert.equal(gas.resolveRubricVariantForRow_('Tomás', 'exact_key'), 'tomas');
});

test('resolveRubricVariantForRow_ maps fallback_heuristic rows to each rep\'s own variant, and Joana to the shared rubric', () => {
  assert.equal(gas.resolveRubricVariantForRow_('Sean', 'fallback_heuristic'), 'sean');
  assert.equal(gas.resolveRubricVariantForRow_('Bens', 'fallback_heuristic'), 'bens');
  assert.equal(gas.resolveRubricVariantForRow_('Tomás', 'fallback_heuristic'), 'tomas');
  assert.equal(gas.resolveRubricVariantForRow_('Joana', 'fallback_heuristic'), 'shared');
});

test('resolveRubricVariantForRow_ maps a QC or Discovery Call Type to the qc variant regardless of rep or match method (29/08/2026: a QC/Discovery call is never a closing call, same reasoning Bens\' own variant was built on, generalized by call type)', () => {
  assert.equal(gas.resolveRubricVariantForRow_('Sean', 'exact_key', 'QC'), 'qc');
  assert.equal(gas.resolveRubricVariantForRow_('Joana', 'fallback_heuristic', 'Discovery'), 'qc');
  assert.equal(gas.resolveRubricVariantForRow_('Tomás', 'exact_key', 'QC'), 'qc');
  assert.equal(gas.resolveRubricVariantForRow_('Bens', 'exact_key', 'Sales Call'), 'shared');
});

// diffRegressionResult_'s array return comes from the vm sandbox's own realm
// (see gas_env.js's Date comment) — assert.deepEqual's constructor-identity
// check fails against this file's plain `[]` literal for realm reasons, not
// a real mismatch, so compare .length / a plain-array copy instead, same
// workaround as the other cross-realm tests above.
test('diffRegressionResult_ reports no drift when nothing changed', () => {
  const baseline = { callQualityScore: 4, askedForClose: true, objectionsHandled: true, frameworkExplained: true, primaryFailureMode: 'none' };
  assert.equal(gas.diffRegressionResult_(baseline, Object.assign({}, baseline)).length, 0);
});

test('diffRegressionResult_ flags a call_quality_score move of more than 1 point, not a move of exactly 1', () => {
  const baseline = { callQualityScore: 3, askedForClose: true, objectionsHandled: true, frameworkExplained: true, primaryFailureMode: 'none' };
  const oneOff = Object.assign({}, baseline, { callQualityScore: 4 });
  assert.equal(gas.diffRegressionResult_(baseline, oneOff).length, 0);

  const twoOff = Object.assign({}, baseline, { callQualityScore: 5 });
  const diffs = gas.diffRegressionResult_(baseline, twoOff);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /call_quality_score drifted 3 -> 5/);
});

test('diffRegressionResult_ flags a flipped boolean flag', () => {
  const baseline = { callQualityScore: 4, askedForClose: true, objectionsHandled: true, frameworkExplained: true, primaryFailureMode: 'none' };
  const flipped = Object.assign({}, baseline, { objectionsHandled: false });
  const diffs = gas.diffRegressionResult_(baseline, flipped);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /Flag: Objections Handled flipped true -> false/);
});

test('diffRegressionResult_ flags a changed Primary Failure Mode', () => {
  const baseline = { callQualityScore: 4, askedForClose: true, objectionsHandled: true, frameworkExplained: true, primaryFailureMode: 'none' };
  const changed = Object.assign({}, baseline, { primaryFailureMode: 'objections_missed' });
  const diffs = gas.diffRegressionResult_(baseline, changed);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /Primary Failure Mode changed none -> objections_missed/);
});

test('diffRegressionResult_ can report multiple simultaneous diffs', () => {
  const baseline = { callQualityScore: 5, askedForClose: true, objectionsHandled: true, frameworkExplained: true, primaryFailureMode: 'none' };
  const drifted = { callQualityScore: 2, askedForClose: false, objectionsHandled: true, frameworkExplained: true, primaryFailureMode: 'no_close_ask' };
  const diffs = gas.diffRegressionResult_(baseline, drifted);
  assert.equal(diffs.length, 3); // score, asked_for_close, primary_failure_mode
});

test('pickStratifiedRegressionSample_ spreads picks across every distinct rep present', () => {
  const items = [
    { rowIndex: 1, rep: 'Sean' }, { rowIndex: 2, rep: 'Sean' }, { rowIndex: 3, rep: 'Sean' },
    { rowIndex: 4, rep: 'Bens' }, { rowIndex: 5, rep: 'Bens' }, { rowIndex: 6, rep: 'Bens' },
    { rowIndex: 7, rep: 'Joana' }, { rowIndex: 8, rep: 'Joana' }, { rowIndex: 9, rep: 'Joana' }
  ];
  const sample = gas.pickStratifiedRegressionSample_(items, 6, () => 0);
  const reps = Array.prototype.slice.call(sample).map((r) => r.rep);
  assert.equal(sample.length, 6);
  assert.ok(reps.indexOf('Sean') !== -1, 'expected at least one Sean pick');
  assert.ok(reps.indexOf('Bens') !== -1, 'expected at least one Bens pick');
  assert.ok(reps.indexOf('Joana') !== -1, 'expected at least one Joana pick');
});

test('pickStratifiedRegressionSample_ tops up from other reps when one rep has too few eligible calls', () => {
  const items = [
    { rowIndex: 1, rep: 'Sean' }, // only one Sean call available
    { rowIndex: 2, rep: 'Bens' }, { rowIndex: 3, rep: 'Bens' }, { rowIndex: 4, rep: 'Bens' }, { rowIndex: 5, rep: 'Bens' }
  ];
  const sample = gas.pickStratifiedRegressionSample_(items, 4, () => 0);
  assert.equal(sample.length, 4); // capped by pool size, but tops up beyond the naive per-rep quota
});

test('pickStratifiedRegressionSample_ does not mutate its input', () => {
  const items = [{ rowIndex: 1, rep: 'Sean' }, { rowIndex: 2, rep: 'Bens' }];
  const before = items.slice();
  gas.pickStratifiedRegressionSample_(items, 1, () => 0.99);
  assert.deepEqual(items, before);
});

test('scoreTranscriptByVariant_ dispatches to the matching rubric-specific judge function', () => {
  // Stub out the four real judge functions (which would otherwise hit
  // UrlFetchApp/the Moonshot API) with sentinels that just report which one
  // was called, so this only tests the dispatch logic itself.
  const calls = [];
  gas.scoreTranscript_ = (ctx) => { calls.push('shared'); return 'shared-result'; };
  gas.scoreSeanTranscript_ = (ctx) => { calls.push('sean'); return 'sean-result'; };
  gas.scoreBensTranscript_ = (ctx) => { calls.push('bens'); return 'bens-result'; };
  gas.scoreTomasTranscript_ = (ctx) => { calls.push('tomas'); return 'tomas-result'; };
  gas.scoreQcTranscript_ = (ctx) => { calls.push('qc'); return 'qc-result'; };

  // Every ctx needs a REAL transcript now — scoreTranscriptByVariant_ refuses
  // to call any judge on an empty/blank-audio one (see the guard's own test
  // below), so an empty {} would never reach the dispatch under test.
  const ctx = { prospectName: 'Test Lead', transcriptText: FAKE_TRANSCRIPT_ };
  assert.equal(gas.scoreTranscriptByVariant_('sean', ctx), 'sean-result');
  assert.equal(gas.scoreTranscriptByVariant_('bens', ctx), 'bens-result');
  assert.equal(gas.scoreTranscriptByVariant_('tomas', ctx), 'tomas-result');
  assert.equal(gas.scoreTranscriptByVariant_('qc', ctx), 'qc-result');
  assert.equal(gas.scoreTranscriptByVariant_('shared', ctx), 'shared-result');
  assert.deepEqual(calls, ['sean', 'bens', 'tomas', 'qc', 'shared']);
});

test('handoffBriefReps_ adds Tomás so he gets briefs for the second calls HE runs, without enrolling him in CONFIG.REPS', () => {
  const reps = gas.handoffBriefReps_();
  const emails = Array.from(reps).map((r) => String(r.email).toLowerCase());
  assert.ok(emails.indexOf(gas.CONFIG.TOMAS_EMAIL.toLowerCase()) !== -1,
    'Kris, 08/09/2026: "Tomás gets handoffs for second calls"');
  // CONFIG.REPS drives the compliance nags and the weekly scorecards, neither
  // of which should suddenly cover him — that is why this is a local list.
  const configEmails = Array.from(gas.CONFIG.REPS).map((r) => String(r.email).toLowerCase());
  assert.equal(configEmails.indexOf(gas.CONFIG.TOMAS_EMAIL.toLowerCase()), -1,
    'CONFIG.REPS itself must be untouched');
  assert.equal(reps.length, gas.CONFIG.REPS.length + 1, 'exactly one addition, no duplicates');
});

test('sendUpcomingHandoffBriefs_ actually ROUTES a lead with no prior call to the first-touch brief instead of silently skipping it', () => {
  // The wiring, not just the builder. Before 08/09/2026 this was a bare
  // `if (!prior) { noMatch++; return; }` and the lead got nothing at all —
  // which is what Joana was actually reporting.
  const orig = {};
  ['LockService', 'SpreadsheetApp', 'Utilities', 'getRepCallEvents_', 'handoffBriefReps_',
   'hasHandoffBriefBeenSent_', 'findMostRecentPriorScoredCall_', 'sendFirstTouchHandoffBrief_',
   'getValidatedColumnMap_', 'log_'].forEach((k) => { orig[k] = gas[k]; });
  let firstTouchSends = 0;
  const ev = { id: 'evt-first-touch', title: 'QC / Cold Lead', start: new Date(), prospectGuess: 'Cold Lead',
    attendeeEmails: ['cold@example.com'], additionalTeamGuestEmails: [] };
  try {
    gas.log_ = () => {};
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.Utilities = { formatDate: realFormatDate, sleep() {} };
    gas.SpreadsheetApp = { openById: () => ({
      getSheetByName: () => ({ getLastRow: () => 1, getRange: () => ({ getValues: () => [] }) }),
      getSheets: () => []
    }) };
    gas.getValidatedColumnMap_ = () => ({});
    gas.handoffBriefReps_ = () => ([{ name: 'Joana', email: 'joana@iconsofrealestate.com' }]);
    gas.getRepCallEvents_ = () => [ev];
    gas.hasHandoffBriefBeenSent_ = () => false;
    gas.findMostRecentPriorScoredCall_ = () => null; // the first-touch case
    gas.sendFirstTouchHandoffBrief_ = (repCfg, event) => {
      firstTouchSends++;
      assert.equal(event.prospectGuess, 'Cold Lead');
      return true;
    };

    gas.sendUpcomingHandoffBriefs_();

    assert.equal(firstTouchSends, 1, 'a lead with no prior call MUST still get a brief');
  } finally {
    Object.keys(orig).forEach((k) => { gas[k] = orig[k]; });
  }
});

test('buildFirstTouchBriefEmailBody_ says plainly there is no prior call, and asks for the goal and the pain the rubric actually grades', () => {
  const body = gas.buildFirstTouchBriefEmailBody_({
    nextRepFirstName: 'Joana',
    prospectName: 'Xavier Long',
    prospectEmail: 'x@example.com',
    nextCallType: 'QC',
    nextCallDateStr: '09/09/2026',
    nextCallTimeStr: '10:00',
    researchLinks: ['https://tiktok.com/@xavier', 'https://instagram.com/xavier']
  });
  assert.ok(body.indexOf('FIRST TOUCH') !== -1, 'must be explicit that nobody has spoken to them');
  assert.ok(body.indexOf('Xavier Long') !== -1);
  assert.ok(body.indexOf('https://tiktok.com/@xavier') !== -1, 'the research is the whole value here');
  // Same two dimensions the rep is about to be graded on — the brief and the
  // scoring must ask for the same thing.
  assert.ok(body.indexOf('THE GOAL') !== -1);
  assert.ok(body.indexOf('THE PAIN') !== -1);
  assert.ok(body.indexOf('condition') !== -1, 'including Tomás\'s condition-vs-pain distinction');
  // It must never claim a colleague briefed them.
  assert.equal(body.indexOf('prior call type'), -1);
});

test('buildFirstTouchBriefEmailBody_ distinguishes "lookup never ran" from "lookup ran and found nothing" (real bug 09/09/2026, Kris: "This email is lazy! No look up of lead" — the lookup was gated OFF, so the old copy claimed a search happened when none did)', () => {
  const neverRan = gas.buildFirstTouchBriefEmailBody_({
    nextRepFirstName: 'Joana', prospectName: 'Nobody Findable', prospectEmail: '',
    nextCallType: 'QC', nextCallDateStr: '09/09/2026', nextCallTimeStr: '10:00', researchLinks: [],
    lookupAttempted: false
  });
  assert.ok(neverRan.indexOf('Automated lookup is off') !== -1);
  assert.ok(neverRan.indexOf('Nothing found by web search') === -1, 'must never claim a search happened when none did');
  assert.ok(neverRan.indexOf('Instagram') !== -1, 'and name where to look — the due diligence Tomás teaches');

  const ranButEmpty = gas.buildFirstTouchBriefEmailBody_({
    nextRepFirstName: 'Joana', prospectName: 'Nobody Findable', prospectEmail: '',
    nextCallType: 'QC', nextCallDateStr: '09/09/2026', nextCallTimeStr: '10:00', researchLinks: [],
    lookupAttempted: true
  });
  assert.ok(ranButEmpty.indexOf('Searched and found nothing solid') !== -1);
});

test('prospectSearchQuery_ uses the prospect\'s email when we have one — real bug 09/09/2026: the name-only query found nothing for a lead the same manual search (name + email) found instantly', () => {
  assert.equal(
    gas.prospectSearchQuery_('Stephen Barton', 'sbarton@gocoremtg.com'),
    '"Stephen Barton" sbarton@gocoremtg.com'
  );
  // No email known — falls back to the old boilerplate query, unchanged.
  assert.equal(
    gas.prospectSearchQuery_('Stephen Barton', ''),
    '"Stephen Barton" LinkedIn OR website OR real estate agent'
  );
});

test('buildFirstTouchBriefEmailHtml_ carries the same real content as the plain-text body, in raw (unescaped) HTML tags — escaped tags render as literal text in Gmail (CLAUDE.md, bitten a prior session)', () => {
  const html = gas.buildFirstTouchBriefEmailHtml_({
    nextRepFirstName: 'Joana', prospectName: 'Stephen Barton', prospectEmail: 'sbarton@gocoremtg.com',
    nextCallType: 'QC', nextCallDateStr: '09/09/2026', nextCallTimeStr: '10:00',
    lookupAttempted: true, researchLinks: ['https://example.com/steve-barton']
  });
  assert.ok(html.indexOf('<p>') !== -1 && html.indexOf('&lt;p&gt;') === -1, 'must be raw HTML, not escaped');
  assert.ok(html.indexOf('THIS IS A FIRST TOUCH') !== -1);
  assert.ok(html.indexOf('https://example.com/steve-barton') !== -1);
  assert.ok(html.indexOf('THE GOAL') !== -1 && html.indexOf('THE PAIN') !== -1);
});

test('sendFirstTouchHandoffBrief_ respects HANDOFF_CONFIG.ENABLED and never marks an event sent unless a real send happened', () => {
  const originalEnabled = gas.HANDOFF_CONFIG.ENABLED;
  const originalGuardedSend = gas.guardedSend_;
  const originalMark = gas.markHandoffBriefSent_;
  const originalLog = gas.log_;
  const originalUtilities = gas.Utilities;
  const originalLinksCfg = gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED;
  let marked = 0, sends = 0;
  const ev = { id: 'evt1', title: 'QC / Xavier Long', start: new Date(), prospectGuess: 'Xavier Long',
    attendeeEmails: ['x@example.com'], additionalTeamGuestEmails: [] };
  const repCfg = { name: 'Joana', email: 'joana@iconsofrealestate.com' };
  try {
    gas.log_ = () => {};
    gas.Utilities = { formatDate: realFormatDate, sleep() {} };
    gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED = false; // no live CSE call in tests
    gas.markHandoffBriefSent_ = () => { marked++; };

    // Disabled: logs, sends nothing, marks nothing.
    gas.HANDOFF_CONFIG.ENABLED = false;
    gas.guardedSend_ = () => { sends++; return true; };
    assert.equal(gas.sendFirstTouchHandoffBrief_(repCfg, ev, gas.CONFIG.BUSINESS_TIMEZONE), false);
    assert.equal(sends, 0);
    assert.equal(marked, 0, 'the 26/08/2026 mark-without-send bug must not come back on this new path');

    // Enabled but the send is refused: still must not mark sent, so it retries.
    gas.HANDOFF_CONFIG.ENABLED = true;
    gas.guardedSend_ = () => { sends++; return false; };
    assert.equal(gas.sendFirstTouchHandoffBrief_(repCfg, ev, gas.CONFIG.BUSINESS_TIMEZONE), false);
    assert.equal(marked, 0);

    // Enabled and sent: marked exactly once, CC carries Tomás (Kris,
    // 09/09/2026: "Need to CC Tomas and ymself" — Kris via
    // buildHandoffBriefCcList_'s always-on CONFIG.KRIS_EMAIL, Tomás added
    // explicitly for the first-touch path only), and htmlBody is populated.
    gas.guardedSend_ = (to, subject, body, opts) => {
      sends++;
      assert.ok(subject.indexOf('[First Touch]') !== -1);
      assert.ok(opts.cc.indexOf(gas.CONFIG.TOMAS_EMAIL) !== -1, 'Tomás must be CC\'d on a first-touch brief');
      assert.ok(opts.cc.indexOf(gas.CONFIG.KRIS_EMAIL) !== -1, 'Kris stays CC\'d, unchanged');
      assert.ok(opts.htmlBody && opts.htmlBody.indexOf('<p>') !== -1, 'must send an HTML body, not plain text only');
      return true;
    };
    assert.equal(gas.sendFirstTouchHandoffBrief_(repCfg, ev, gas.CONFIG.BUSINESS_TIMEZONE), true);
    assert.equal(marked, 1);
  } finally {
    gas.HANDOFF_CONFIG.ENABLED = originalEnabled;
    gas.guardedSend_ = originalGuardedSend;
    gas.markHandoffBriefSent_ = originalMark;
    gas.log_ = originalLog;
    gas.Utilities = originalUtilities;
    gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED = originalLinksCfg;
  }
});

test('goalAndPainRubricPrompt_ defines pain the way Tomás corrected it, not the way the obvious answer would', () => {
  const t = gas.goalAndPainRubricPrompt_();
  assert.ok(t.indexOf('uncovered_goal') !== -1);
  assert.ok(t.indexOf('uncovered_pain') !== -1);

  // The whole point of the correction. Kris's instinct was "not selling
  // enough houses"; Tomás: "it's not particularly a pain. It's like a
  // disease, it's a condition." If the prompt loses this, the flag grades
  // the wrong thing and every rep passes it trivially.
  assert.ok(/condition, not\s*\n?\s*.*a pain|is a condition/i.test(t) || t.indexOf('condition') !== -1,
    'must state that a shortfall against the goal is a condition, not a pain');
  assert.ok(t.indexOf('Google') !== -1, 'must carry Tomás\'s concrete examples (no profile when Googled)');
  assert.ok(t.indexOf('engagement') !== -1);
  assert.ok(t.indexOf('recruiting') !== -1, 'including the recruiting-conversations pain he named');
  assert.ok(t.indexOf('scores FALSE') !== -1,
    'must say explicitly that establishing only the numeric gap fails this flag');

  // And a goal has to be specific, not "wants to grow".
  assert.ok(t.indexOf('"Wants to grow" is not a goal') !== -1);
});

test('every rubric variant that scores discovery also scores goal and pain, with one shared definition', () => {
  // Joana's calls now resolve to 'shared' and Sean has his own variant — if
  // the definition lived in only one of them, the two reps who actually get
  // discovery training would be graded against different standards.
  const shared = gas.buildJudgeSystemPrompt_ ? gas.buildJudgeSystemPrompt_() : null;
  const sean = gas.buildSeanJudgeSystemPrompt_();
  const tomas = gas.buildTomasJudgeSystemPrompt_();
  [['sean', sean], ['tomas', tomas]].forEach(([name, prompt]) => {
    assert.ok(prompt.indexOf('uncovered_goal') !== -1, name + ' must ask for uncovered_goal');
    assert.ok(prompt.indexOf('uncovered_pain') !== -1, name + ' must ask for uncovered_pain');
    assert.ok(prompt.indexOf('is a condition') !== -1, name + ' must carry the same pain definition, not its own');
  });
  if (shared) {
    assert.ok(shared.indexOf('uncovered_goal') !== -1, 'the shared rubric (Joana) must ask for it too');
  }
});

test('buildSeanJudgeSystemPrompt_ explicitly tells the judge not to require Tomás\'s name for booked_second_call_with_tomas (real bug found live: Bruce Henson row 377 scored false when Tomás confirmed it was actually true — the transcript has a concrete second call booked for "Thursday at 1030" but never names Tomás, since his joining that call is our own back-office process, not something the rep announces to the lead)', () => {
  const prompt = gas.buildSeanJudgeSystemPrompt_();
  assert.ok(prompt.indexOf('do NOT require the transcript to say') !== -1,
    'the prompt must explicitly forbid requiring Tomás\'s name to appear in the transcript');
  assert.ok(prompt.indexOf('our own back-office process') !== -1,
    'the prompt must explain WHY: Tomás joining is internal, not something the lead is told about on this call');
  // The old literal question this bug traces to — must not survive as the
  // question the judge is actually asked (a real-example callout referencing
  // the old wording as an explanation is fine; the bare literal question is not).
  assert.equal(/was a second call with Tomás actually booked\?/.test(prompt), false,
    'the old over-literal question wording must be gone, not just supplemented');
  assert.ok(prompt.indexOf('second/closing call was/wasn\'t booked') !== -1,
    'feedback_summary\'s field description must use the same non-literal wording, not just the reasoning question');
});

test('DISCOVERY_GAP_LABELS_ names the new dimensions, so a failure on them shows up in the Missing line', () => {
  assert.equal(gas.DISCOVERY_GAP_LABELS_.uncovered_goal, 'what the lead is running TOWARDS (their goal)');
  assert.equal(gas.DISCOVERY_GAP_LABELS_.uncovered_pain, 'what the lead is running FROM (their real pain)');

  // deriveDiscoveryFields_ iterates these keys, so the new ones flow into the
  // Discovery Gaps column with no further wiring — and a variant that doesn't
  // return them is still "not judged", never a failure.
  const failedBoth = gas.deriveDiscoveryFields_({
    flags: { discovery_adequate: true, understood_leads_business: true, uncovered_goal: false, uncovered_pain: false }
  });
  assert.equal(failedBoth.adequate, false);
  assert.ok(failedBoth.gapsText.indexOf('running TOWARDS') !== -1);
  assert.ok(failedBoth.gapsText.indexOf('running FROM') !== -1);

  const notJudged = gas.deriveDiscoveryFields_({ flags: { discovery_adequate: true, understood_leads_business: true } });
  assert.equal(notJudged.gapsText.indexOf('running TOWARDS'), -1,
    'a variant that never scored goal/pain must not report them as gaps');
});

test('RUBRIC_VERSION moved, so the new dimensions actually get backfilled by a rescore', () => {
  // rescoreAllCalls_ only touches rows whose Rubric Version is behind the
  // current one — without a bump, no existing row would ever be graded on
  // goal/pain and the change would silently apply to new calls only.
  assert.equal(gas.RUBRIC_VERSION, '2026-09-10-industry-partner-carveout');
});

test('joanaMislabelledCallTypeRows_ finds only the rows this backfill created, never a QC that arrived some other way', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const row = (over) => {
    const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
    Object.keys(over).forEach((k) => { r[col[k] - 1] = over[k]; });
    return r;
  };
  const rows = [
    row({ Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'fallback_heuristic', 'Prospect Name': 'Mislabelled One' }),
    // A QC Joana genuinely ran, logged some other way — must be left alone.
    row({ Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key', 'Prospect Name': 'Real QC' }),
    // Already correct.
    row({ Rep: 'Joana', 'Call Type': 'Sales Call', 'Match Method': 'fallback_heuristic', 'Prospect Name': 'Already Right' }),
    // Another rep's QC — Sean's come from folder labels and are correct.
    row({ Rep: 'Sean', 'Call Type': 'QC', 'Match Method': 'fallback_heuristic', 'Prospect Name': 'Sean QC' })
  ];
  const hits = gas.joanaMislabelledCallTypeRows_(rows, col, null);
  assert.equal(hits.length, 1, 'exactly one row qualifies');
  assert.equal(hits[0].prospectName, 'Mislabelled One');
  assert.equal(hits[0].rowIndex, 2, 'sheet row index, header-offset');
});

test('nameSaysQualificationCall_ spots a filename that names the call type, without false-positiving on ordinary names', () => {
  // Real rows from the 08/09/2026 preview run.
  assert.equal(gas.nameSaysQualificationCall_('Elizabeth Oluwakemi QC 1'), true);
  assert.equal(gas.nameSaysQualificationCall_('Someone QC2'), true);
  assert.equal(gas.nameSaysQualificationCall_('Name - QC'), true);
  assert.equal(gas.nameSaysQualificationCall_('qc 3 Somebody'), true);

  // The mirror case is fine to miss — SC rows want the default anyway.
  assert.equal(gas.nameSaysQualificationCall_('Jason Pietruszka SC 1'), false);
  assert.equal(gas.nameSaysQualificationCall_('Jason Pietruszka SC 2'), false);

  // Must not eat a real person whose name merely contains those letters.
  assert.equal(gas.nameSaysQualificationCall_('Quincy Adams'), false);
  assert.equal(gas.nameSaysQualificationCall_('Marija Volkman'), false);
  assert.equal(gas.nameSaysQualificationCall_('Stacie Staub'), false);
  assert.equal(gas.nameSaysQualificationCall_(''), false);
  assert.equal(gas.nameSaysQualificationCall_(null), false);
});

test('joanaMislabelledCallTypeRows_ leaves a row alone when its own name says QC (found in the real preview run)', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const row = (name) => {
    const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
    r[col['Rep'] - 1] = 'Joana';
    r[col['Call Type'] - 1] = 'QC';
    r[col['Match Method'] - 1] = 'fallback_heuristic';
    r[col['Prospect Name'] - 1] = name;
    return r;
  };
  const hits = gas.joanaMislabelledCallTypeRows_(
    [row('Elizabeth Oluwakemi QC 1'), row('Jason Pietruszka SC 1'), row('Stacie Staub')], col, null);
  assert.deepEqual(Array.from(hits).map((h) => h.prospectName), ['Jason Pietruszka SC 1', 'Stacie Staub'],
    'the row that names itself a QC must be skipped — she does run real QCs');
});

test('joanaMislabelledCallTypeRows_ can scope to last week, the window the training picker actually reads', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const week = gas.getWeekBounds_(new gas.Date(), gas.CONFIG.BUSINESS_TIMEZONE);
  const inWeek = new gas.Date(week.start.getTime() + 24 * 3600 * 1000);
  const longAgo = new gas.Date(week.start.getTime() - 60 * 24 * 3600 * 1000);
  const row = (name, date) => {
    const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
    r[col['Rep'] - 1] = 'Joana';
    r[col['Call Type'] - 1] = 'QC';
    r[col['Match Method'] - 1] = 'fallback_heuristic';
    r[col['Prospect Name'] - 1] = name;
    r[col['Call Date'] - 1] = date;
    return r;
  };
  const rows = [row('In Window', inWeek), row('Two Months Ago', longAgo)];
  const scoped = gas.joanaMislabelledCallTypeRows_(rows, col, week);
  assert.deepEqual(Array.from(scoped).map((h) => h.prospectName), ['In Window']);
  assert.equal(gas.joanaMislabelledCallTypeRows_(rows, col, null).length, 2, 'unscoped still covers history');
});

test('JOANA_DEFAULT_CALL_TYPE_ is Sales Call and matches the rubric her scoring actually applies, while Bens keeps the QC legacy default', () => {
  // The whole bug: her rows were scored under the SHARED (sales) rubric by
  // scoreJoanaTranscripts and then labelled 'QC', so any later rescore
  // re-dispatched them onto the QC rubric and the scores moved with it.
  assert.equal(gas.JOANA_DEFAULT_CALL_TYPE_, 'Sales Call');
  assert.equal(gas.rubricVariantForNewScore_('Joana', gas.JOANA_DEFAULT_CALL_TYPE_), 'shared',
    'the label must now resolve to the same rubric her original scoring used');
  assert.equal(gas.PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE, 'QC',
    'Bens\' legacy backfill default must be untouched — his QC rows really are QCs');
});

test('callTypeForLegacyRow_ labels a Bens guest interview "Icons 100 Recording" instead of the flat QC default (Kris, 09/09/2026: "How do we setup a grading for ICONS 100?")', () => {
  assert.equal(gas.callTypeForLegacyRow_({ call_role: 'icons_100_interview' }), 'Icons 100 Recording');
  // A real QC (call_role 'qc') and Joana's plain scoreTranscript_ result
  // (no call_role field at all) must both still fall back to the old flat
  // default — this only ever special-cases the interview role.
  assert.equal(gas.callTypeForLegacyRow_({ call_role: 'qc' }), gas.PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE);
  assert.equal(gas.callTypeForLegacyRow_({ call_role: 'unclear' }), gas.PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE);
  assert.equal(gas.callTypeForLegacyRow_({ feedback_summary: 'no call_role field at all' }),
    gas.PHASE2_CONFIG.LEGACY_DEFAULT_CALL_TYPE);
});

test('callTypeForLegacyRow_-labelled rows resolve to the Bens rubric on a future rescore instead of silently downgrading to plain QC', () => {
  // The real second bug this fixes: resolveRubricVariantForRow_ checks
  // callType === 'QC' BEFORE it ever checks rep === 'Bens', so as long as
  // these rows stayed labelled 'QC', any later rescore would drop the
  // interview-content-quality dimension entirely without anyone noticing.
  const callType = gas.callTypeForLegacyRow_({ call_role: 'icons_100_interview' });
  assert.equal(gas.resolveRubricVariantForRow_('Bens', 'fallback_heuristic', callType), 'bens');
});

test('bensMislabelledInterviewRows_ finds only Bens\' rows the AI already graded as an interview but the sheet still calls "QC"', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const row = (over) => {
    const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
    Object.keys(over).forEach((k) => { r[col[k] - 1] = over[k]; });
    return r;
  };
  const rows = [
    row({
      Rep: 'Bens', 'Call Type': 'QC', 'Prospect Name': 'Mislabelled Interview',
      'AI Feedback Summary': 'Some feedback.\n\nCall type: icons_100_interview\nBooked next step: true (Sales Call)'
    }),
    // A real QC he ran — must be left alone, no interview marker in the feedback.
    row({
      Rep: 'Bens', 'Call Type': 'QC', 'Prospect Name': 'Real QC',
      'AI Feedback Summary': 'Some feedback.\n\nCall type: qc\nBooked next step: true (Sales Call)'
    }),
    // Already correct.
    row({
      Rep: 'Bens', 'Call Type': 'Icons 100 Recording', 'Prospect Name': 'Already Right',
      'AI Feedback Summary': 'Call type: icons_100_interview'
    }),
    // Another rep's QC with the marker text coincidentally present — not his to touch.
    row({
      Rep: 'Sean', 'Call Type': 'QC', 'Prospect Name': 'Sean QC',
      'AI Feedback Summary': 'Call type: icons_100_interview'
    })
  ];
  const hits = gas.bensMislabelledInterviewRows_(rows, col);
  assert.equal(hits.length, 1, 'exactly one row qualifies');
  assert.equal(hits[0].prospectName, 'Mislabelled Interview');
  assert.equal(hits[0].rowIndex, 2, 'sheet row index, header-offset');
});

test('a row whose score is fake is listed for Tomás but can never be ranked as a failed element (Frank Pirrone, 08/09/2026)', () => {
  // The sentinel writes every flag false, so before this it ranked as a real
  // failure on every element at once and won the week's focus outright.
  const parseFailure = 'Automated scoring failed twice to return parseable JSON; needs manual review.';
  assert.equal(gas.callScoreIsUnusableForStats_(parseFailure), true, 'precondition: Phase5 already calls this fake');

  const usable = { score: 2, flags: { discovery: false, framework: false }, gaps: {} };
  const fake = { score: 1, flags: {}, gaps: {}, scoreIsUnusable: true };
  const ranking = gas.rankTrainingPriorities_([usable, fake]);
  const discovery = ranking.filter((r) => r.key === 'discovery')[0];
  assert.equal(discovery.scored, 1, 'only the usable call counts toward the denominator');
  assert.equal(discovery.failed, 1, 'and only its failure counts — the fake row contributes nothing');
  assert.equal(discovery.failedCalls.length, 1);
  assert.ok(!discovery.failedCalls.some((c) => c.scoreIsUnusable), 'a dead recording must never become a coaching case');
});

test('transcriptIsUnusableForScoring_ catches a failed recording without catching a genuinely short bad call', () => {
  assert.equal(gas.transcriptIsUnusableForScoring_(''), true, 'empty');
  assert.equal(gas.transcriptIsUnusableForScoring_('   \n  '), true, 'whitespace only');
  assert.equal(gas.transcriptIsUnusableForScoring_('[BLANK_AUDIO] [BLANK_AUDIO] [BLANK_AUDIO]'), true, 'pure silence');
  assert.equal(gas.transcriptIsUnusableForScoring_(null), true, 'nothing at all');

  // Frank Pirrone's real shape (08/09/2026): a couple of minutes of Zoom
  // troubleshooting, then blank audio for the rest. Scored 1/5 and served to
  // Tomás as the worst call of Sean's week.
  assert.equal(gas.transcriptIsUnusableForScoring_(
    'Rep: Can you hear me? [BLANK_AUDIO] [BLANK_AUDIO] Prospect: Hello? [BLANK_AUDIO]'), true);

  // The line this must NOT cross: a real call that was short and went badly
  // is still a real call, and must still be scored and coached on.
  assert.equal(gas.transcriptIsUnusableForScoring_(FAKE_TRANSCRIPT_), false, 'a real call must still be scored');
});

test('scoreTranscriptByVariant_ returns the unusable-recording result instead of calling ANY judge when the transcript is dead', () => {
  const calls = [];
  gas.scoreTranscript_ = () => { calls.push('shared'); return 'shared-result'; };
  gas.scoreQcTranscript_ = () => { calls.push('qc'); return 'qc-result'; };
  const originalLog = gas.log_;
  gas.log_ = () => {};
  try {
    const result = gas.scoreTranscriptByVariant_('qc', { prospectName: 'Frank Pirrone', transcriptText: '[BLANK_AUDIO]' });
    assert.equal(calls.length, 0, 'no model call may be made — that is the cost saving AND the correctness fix');
    assert.equal(result._unusableTranscript, true);
    // Blank, not 1. A number here is what made a failed recording look like
    // a terrible rep (Tomás: "this shouldn't be a grade").
    assert.equal(result.call_quality_score, '', 'the score must be BLANK, never a number');
    assert.deepEqual(Object.assign({}, result.flags), {}, 'no flags, so it can never rank as a failed element');
    assert.ok(result.feedback_summary.indexOf('[BLANK_AUDIO]') !== -1,
      'must carry the marker Phase5\'s callScoreIsUnusableForStats_ already excludes on');
    assert.equal(gas.callScoreIsUnusableForStats_(result.feedback_summary), true,
      'and that existing exclusion must actually catch it, not just look like it would');
  } finally {
    gas.log_ = originalLog;
  }
});

test('buildFeedbackSummaryForVariant_ dispatches to each variant\'s own packer, and falls back to the model\'s bare feedback_summary for shared/unrecognized (29/08/2026, closing the gap where the ongoing pipeline used to only ever write the bare model summary regardless of variant)', () => {
  const bareResult = { feedback_summary: 'bare summary' };
  assert.equal(gas.buildFeedbackSummaryForVariant_('shared', bareResult), 'bare summary');
  assert.equal(gas.buildFeedbackSummaryForVariant_('nonsense-unknown-variant', bareResult), 'bare summary');

  const qcResult = perfectQcResult_();
  qcResult.feedback_summary = 'qc summary';
  qcResult.root_cause_if_no_booking = 'N/A';
  const packed = gas.buildFeedbackSummaryForVariant_('qc', qcResult);
  assert.match(packed, /qc summary/);
  assert.match(packed, /Booked Sales Call: true/);
  assert.match(packed, /Delivery effective: true/, '29/08/2026: the packed summary must include the delivery dimension too, not just framework/booking');
});

test('writeScoreToRow_ uses the variant-specific feedback summary packer, not just the model\'s bare feedback_summary, when a variant is passed', () => {
  const cells = {};
  const fakeSheet = { getRange(row, col) { return { setValue(v) { cells[row + ':' + col] = v; return this; } }; } };
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });

  const result = perfectQcResult_();
  result.lead_quality = { verdict: 'good_to_book' };
  result.manual_review_recommended = false;
  result.severity = 1;
  result.feedback_summary = 'bare qc summary';
  result.primary_failure_mode = 'none';
  result.root_cause_if_no_booking = 'N/A';

  gas.writeScoreToRow_(fakeSheet, 3, col, result, false, 'Some Prospect', 'qc');

  const written = cells['3:' + col['AI Feedback Summary']];
  assert.match(written, /bare qc summary/);
  assert.match(written, /Booked Sales Call: true/, 'the packed QC-specific extras must be in the written summary, not just the bare model line');
});

test('ghlNoteIsOurOwn_ recognises our own AI review notes, so they stop counting as somebody working the lead', () => {
  // Confirmed live 09/09/2026: eight triaged contacts showed a "last GHL
  // activity" timestamp matching our own note-sync run to the second.
  assert.equal(gas.ghlNoteIsOurOwn_({ body: '<strong>AI Call Review</strong> — 05/09/2026 — QC (Bens)' }), true);
  assert.equal(gas.ghlNoteIsOurOwn_({ note: 'AI Call Review — something' }), true);
  // A real human note must NOT be filtered out.
  assert.equal(gas.ghlNoteIsOurOwn_({ body: 'Spoke to her, calling back Tuesday' }), false);
  assert.equal(gas.ghlNoteIsOurOwn_({}), false);
  assert.equal(gas.ghlNoteIsOurOwn_(null), false);
});

test('ghlMessageIsAutomated_ recognises a workflow-sourced or campaign-type message, so it stops counting as a human touch (Fable review finding, 10/09/2026 — same class of bug as ghlNoteIsOurOwn_, just for messages instead of notes)', () => {
  assert.equal(gas.ghlMessageIsAutomated_({ source: 'workflow', messageType: 'TYPE_SMS' }), true,
    'source: "workflow" alone must be enough, regardless of messageType');
  assert.equal(gas.ghlMessageIsAutomated_({ messageType: 'TYPE_CAMPAIGN_SMS' }), true);
  assert.equal(gas.ghlMessageIsAutomated_({ messageType: 'TYPE_CAMPAIGN_EMAIL' }), true);
  assert.equal(gas.ghlMessageIsAutomated_({ type: 'TYPE_CAMPAIGN_CALL' }), true, 'must also check the "type" field, not only "messageType"');
  // A real human-sent message must NOT be filtered out.
  assert.equal(gas.ghlMessageIsAutomated_({ source: 'app', messageType: 'TYPE_SMS' }), false);
  assert.equal(gas.ghlMessageIsAutomated_({ messageType: 'TYPE_CALL' }), false);
  assert.equal(gas.ghlMessageIsAutomated_({}), false);
  assert.equal(gas.ghlMessageIsAutomated_(null), false);
});

test('ghlMostRecentConversationDate_ excludes automated messages from the "most recent" calculation, only counting genuine human activity', () => {
  const originalConv = gas.ghlListConversationsForContact_;
  const originalMsgs = gas.ghlListMessagesInConversation_;
  try {
    gas.ghlListConversationsForContact_ = () => ({ ok: true, conversations: [{ id: 'convo-1' }] });
    gas.ghlListMessagesInConversation_ = () => ({
      ok: true,
      messages: [
        { dateAdded: '2026-09-09T10:00:00.000Z', source: 'workflow' }, // most recent, but automated — must be excluded
        { dateAdded: '2026-09-05T10:00:00.000Z', messageType: 'TYPE_SMS' } // genuine human touch, older
      ]
    });
    const result = gas.ghlMostRecentConversationDate_('loc-1', 'contact-1');
    assert.equal(result, '2026-09-05T10:00:00.000Z',
      'must return the most recent HUMAN message date, not the most recent message overall');
  } finally {
    gas.ghlListConversationsForContact_ = originalConv;
    gas.ghlListMessagesInConversation_ = originalMsgs;
  }
});

test('ghlMostRecentConversationDate_ returns null when every message on the contact is automated, rather than falsely reporting recent human activity', () => {
  const originalConv = gas.ghlListConversationsForContact_;
  const originalMsgs = gas.ghlListMessagesInConversation_;
  try {
    gas.ghlListConversationsForContact_ = () => ({ ok: true, conversations: [{ id: 'convo-1' }] });
    gas.ghlListMessagesInConversation_ = () => ({
      ok: true,
      messages: [{ dateAdded: '2026-09-09T10:00:00.000Z', source: 'workflow' }]
    });
    assert.equal(gas.ghlMostRecentConversationDate_('loc-1', 'contact-1'), null);
  } finally {
    gas.ghlListConversationsForContact_ = originalConv;
    gas.ghlListMessagesInConversation_ = originalMsgs;
  }
});

test('ghlMostRecentConversationDate_ skips a conversation whose message fetch fails, rather than failing the whole lookup (best-effort, same posture as every other lookup in this file)', () => {
  const originalConv = gas.ghlListConversationsForContact_;
  const originalMsgs = gas.ghlListMessagesInConversation_;
  try {
    gas.ghlListConversationsForContact_ = () => ({
      ok: true,
      conversations: [{ id: 'broken-convo' }, { id: 'good-convo' }]
    });
    gas.ghlListMessagesInConversation_ = (id) => id === 'broken-convo'
      ? { ok: false, status: 500, body: 'boom', messages: [] }
      : { ok: true, messages: [{ dateAdded: '2026-09-05T10:00:00.000Z', messageType: 'TYPE_SMS' }] };
    assert.equal(gas.ghlMostRecentConversationDate_('loc-1', 'contact-1'), '2026-09-05T10:00:00.000Z');
  } finally {
    gas.ghlListConversationsForContact_ = originalConv;
    gas.ghlListMessagesInConversation_ = originalMsgs;
  }
});

test('buildGhlStageTriageSuggestion_ gives the decisive suggestion once our own notes stop masking a dead lead', () => {
  // This is the behaviour the contamination was suppressing: on a stale
  // "Booked" stage with no real human touch, the tool should say what to do
  // rather than punt to "needs a human look". 38 of 50 live rows punted.
  const dead = gas.buildGhlStageTriageSuggestion_({
    stageName: 'Qualification Call Booked', staleDays: 231,
    activity: { lastNoteDate: null, lastConversationDate: null, hasFutureAppointment: false }
  });
  assert.ok(/Not Taken/.test(dead.action), 'a genuinely untouched booked stage gets the decisive action');

  // A real human touch still correctly routes to the softer suggestion.
  const touched = gas.buildGhlStageTriageSuggestion_({
    stageName: 'Qualification Call Booked', staleDays: 231,
    activity: { lastNoteDate: '2026-09-05T05:52:57.000Z', lastConversationDate: null, hasFutureAppointment: false }
  });
  assert.ok(/has activity/.test(touched.action));
});

test('the two GHL activity dates are now both ISO, so "most recent" is a real comparison and not a string sort across formats', () => {
  // GHL returns note dates as ISO and conversation dates as epoch ms.
  // Sorted as plain strings, "1787216916228" always loses to "2026-..." —
  // so an older note beat a newer conversation every time.
  const noteIso = gas.ghlTimestampToIso_('2026-01-30T00:00:00.000Z');
  const conversationIso = gas.ghlTimestampToIso_(1787216916228); // 20/08/2026 — genuinely newer
  const mostRecent = [noteIso, conversationIso].filter(Boolean).sort().pop();
  assert.equal(mostRecent, conversationIso,
    'the newer conversation must win now that both sides are normalised to ISO');
  // Guard the regression directly: the raw epoch would have lost this compare.
  const rawEpochLoses = ['2026-01-30T00:00:00.000Z', String(1787216916228)].sort().pop();
  assert.equal(rawEpochLoses, '2026-01-30T00:00:00.000Z',
    'documents the old broken behaviour this fix removes');
});

test('computeGoalProgress_ counts EVERY call Bens ran — his call types are all excluded from the sales-call filter', () => {
  // Found in review 09/09/2026: isSalesCallTypeForScorecard_ excludes qc,
  // discovery AND "icons 100 recording" — which is every call type Bens ever
  // runs. Counting only sales calls told him "calls you ran this week: 0"
  // every week regardless of how much work he did.
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const row = (callType) => {
    const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
    r[col['Rep'] - 1] = 'Bens';
    r[col['Call Type'] - 1] = callType;
    r[col['Call Date'] - 1] = new gas.Date('2026-09-09T10:00:00Z');
    return r;
  };
  const p = gas.computeGoalProgress_(
    [row('Icons 100 Recording'), row('Icons 100 Recording'), row('QC')], col, 'Bens',
    new gas.Date('2026-09-07T00:00:00Z'), new gas.Date('2026-09-14T00:00:00Z'), gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(p.callsRun, 3, 'all three of his calls count as work he did');
  assert.equal(p.salesCallsHeld, 0, 'none of them are sales calls, which is correct and separate');

  const section = gas.buildGoalProgressSection_('Bens', p);
  assert.ok(section.plain.indexOf('Calls you ran this week: 3') !== -1,
    'his email must show the real number, not the sales-call count of 0');
});

test('the reported close rate uses the same denominator as the target it is compared against', () => {
  // Found in review 09/09/2026: closeRate was deals/outcomesLogged while the
  // 30% target means deals per call HELD. With 4 held, 2 logged, 1 sold the
  // email announced "50% against a 30% target" when the true rate is at most
  // 25% — and since reps log a win more readily than a loss, the error ran
  // systematically in the flattering direction.
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const row = (disposition) => {
    const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
    r[col['Rep'] - 1] = 'Joana';
    r[col['Call Type'] - 1] = 'Sales Call';
    r[col['Call Date'] - 1] = new gas.Date('2026-09-09T10:00:00Z');
    if (disposition) r[col['Outcome Disposition'] - 1] = disposition;
    return r;
  };
  const p = gas.computeGoalProgress_(
    [row('Sold'), row('Not Sold'), row(''), row('')], col, 'Joana',
    new gas.Date('2026-09-07T00:00:00Z'), new gas.Date('2026-09-14T00:00:00Z'), gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(p.salesCallsHeld, 4);
  assert.equal(p.outcomesLogged, 2);
  assert.equal(p.dealsClosed, 1);
  assert.ok(Math.abs(p.closeRate - 0.25) < 1e-9,
    '1 sold out of 4 calls held is 25%, never the 50% the old denominator produced');

  // Coverage is exactly 0.5 here, so the guard passes and the rate is shown —
  // it must be framed as a floor, never as a bare number that reads final.
  const section = gas.buildGoalProgressSection_('Joana', p);
  assert.ok(/at least 25%/.test(section.plain), 'shown as a floor: ' + section.plain);
  assert.ok(section.plain.indexOf('50%') === -1, 'the inflated rate must not appear anywhere');
});

test('the post-sale Discovery rubric never gets the part-time screen-out rule — the customer has already bought', () => {
  // Found in review 09/09/2026: a blanket insertion put leadQualityCriteriaPrompt_
  // into all six variants, including the account manager's post-sale
  // onboarding call, whose own schema says "always good_to_book; this call
  // does not re-decide whether the lead was worth pursuing". A paying
  // customer could have been screened out and dropped from the review queue.
  const discovery = gas.buildDiscoveryJudgeSystemPrompt_();
  assert.ok(discovery.indexOf('FULL-TIME real estate agents') === -1,
    'the screen-out rule must not reach the post-sale variant');
  assert.ok(discovery.indexOf('always good_to_book') !== -1,
    'and its own always-good_to_book instruction must still stand unopposed');

  // The five PRE-sale variants must still carry it.
  [gas.buildJudgeSystemPrompt_(), gas.buildBensJudgeSystemPrompt_(), gas.buildQcJudgeSystemPrompt_(),
   gas.buildSeanJudgeSystemPrompt_(), gas.buildTomasJudgeSystemPrompt_()].forEach((prompt, i) => {
    assert.ok(prompt.indexOf('FULL-TIME real estate agents') !== -1,
      'pre-sale variant ' + i + ' must keep the qualification rule');
  });
});

test('leadQualityCriteriaPrompt_ carries Tomás\'s industry-partner carve-out, so a podcast guest who is not a real estate agent at all does not get screened out under the full-time-agent rule (Tomás, 10/09/2026, qualifying his own earlier rule: "it\'s not black and white as some industry partners might show up to [start] a podcast")', () => {
  const prompt = gas.leadQualityCriteriaPrompt_();
  assert.ok(prompt.indexOf('NOT BLACK AND WHITE') !== -1,
    'the carve-out must be present and clearly flagged as qualifying the rule above it');
  assert.ok(prompt.indexOf('PODCAST GUEST') !== -1,
    'must explicitly name the case Tomás described — an industry partner appearing as a guest, not a lead being sold the offer');
  assert.ok(prompt.indexOf('narrow') !== -1 && prompt.indexOf('applies in full') !== -1,
    'must explicitly bound the carve-out so it cannot be read as loosening the part-time-agent screen-out for an actual sales lead');
});

test('isValidTrainingReviewSchema_ rejects a malformed discovery drill instead of emailing "undefined — undefined"', () => {
  const base = {
    attended: true, practiced_objections: true, practiced_close_ask: true, practiced_framework: true,
    practiced_discovery: true, coaching_notes: 'x', next_focus: 'y', team_notes: 'none',
    objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [],
    discovery_habits_to_drill: [{ label: 'ask for a number', note: 'not "wants to grow"' }],
    tomas_coaching: { grounded_in_real_data: true, gave_concrete_next_focus: true, coaching_feedback_summary: 'z', facilitation_action_for_next_time: 'z' }
  };
  assert.equal(gas.isValidTrainingReviewSchema_(base), true);
  // Bare strings, or the wrong key names, must fail rather than be persisted
  // and rendered as an undefined drill in the rep's practice email.
  assert.equal(gas.isValidTrainingReviewSchema_(
    Object.assign({}, base, { discovery_habits_to_drill: ['ask for a number'] })), false);
  assert.equal(gas.isValidTrainingReviewSchema_(
    Object.assign({}, base, { discovery_habits_to_drill: [{ habit: 'x', note: 'y' }] })), false);
  assert.equal(gas.isValidTrainingReviewSchema_(
    Object.assign({}, base, { discovery_habits_to_drill: 'not an array' })), false);
});

test('salesCallsNeededPerWeek_ turns Kris\'s targets into a real weekly number, rounding UP', () => {
  // 1 deal a week at a 30% close rate = 4 held sales calls, not 3.33 and not
  // 3 — rounding down would set a target that cannot arithmetically be hit.
  assert.equal(gas.salesCallsNeededPerWeek_(1, 0.30), 4);
  assert.equal(gas.salesCallsNeededPerWeek_(2, 0.50), 4);
  assert.equal(gas.salesCallsNeededPerWeek_(1, 1), 1);
  assert.equal(gas.salesCallsNeededPerWeek_(1, 0), null, 'a zero close rate has no answer, not Infinity');
});

test('REP_GOALS_ carries Kris\'s 09/09/2026 targets: one deal a week each for the closers, 30% close rate', () => {
  assert.equal(gas.REP_GOALS_.DEALS_PER_CLOSER_PER_WEEK, 1);
  assert.equal(gas.REP_GOALS_.SALES_CALL_CLOSE_RATE_TARGET, 0.30);
  assert.deepEqual(Array.prototype.slice.call(gas.REP_GOALS_.CLOSERS).sort(), ['Joana', 'Sean']);
  assert.equal(gas.REP_GOALS_.LEAD_GEN.rep, 'Bens');
  assert.equal(gas.REP_GOALS_.LEAD_GEN.feedsCloser, 'Joana');
});

test('computeGoalProgress_ counts held sales calls and deals, and reports outcome coverage separately', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const row = (over) => {
    const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
    Object.keys(over).forEach((k) => { r[col[k] - 1] = over[k]; });
    return r;
  };
  const weekStart = new gas.Date('2026-09-07T00:00:00Z');
  const weekEnd = new gas.Date('2026-09-14T00:00:00Z');
  const inWeek = new gas.Date('2026-09-09T10:00:00Z');

  const rows = [
    row({ Rep: 'Joana', 'Call Type': 'Sales Call', 'Call Date': inWeek, 'Outcome Disposition': 'Sold' }),
    row({ Rep: 'Joana', 'Call Type': 'Sales Call', 'Call Date': inWeek, 'Outcome Disposition': 'Not Sold' }),
    row({ Rep: 'Joana', 'Call Type': 'Sales Call', 'Call Date': inWeek }), // no outcome logged
    // A QC is not a sales call and must not count toward the sales-call target.
    row({ Rep: 'Joana', 'Call Type': 'QC', 'Call Date': inWeek, 'Outcome Disposition': 'Sold' }),
    // Another rep's call, and one outside the week — both excluded.
    row({ Rep: 'Sean', 'Call Type': 'Sales Call', 'Call Date': inWeek, 'Outcome Disposition': 'Sold' }),
    row({ Rep: 'Joana', 'Call Type': 'Sales Call', 'Call Date': new gas.Date('2026-08-01T10:00:00Z'), 'Outcome Disposition': 'Sold' })
  ];

  const p = gas.computeGoalProgress_(rows, col, 'Joana', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(p.salesCallsHeld, 3, 'only this rep\'s in-week sales calls count');
  assert.equal(p.dealsClosed, 1);
  assert.equal(p.outcomesLogged, 2);
  assert.equal(p.salesCallsTarget, 4);
  // Close rate is deals over calls HELD — the same denominator the 30% target
  // is defined on. 1 sold out of 3 held. (An earlier version of this test
  // asserted deals/outcomesLogged, which read high; see the dedicated
  // denominator test above.)
  assert.ok(Math.abs(p.closeRate - (1 / 3)) < 1e-9, 'close rate is deals over calls HELD');
  assert.ok(Math.abs(p.coverage - (2 / 3)) < 1e-9);
});

test('computeGoalProgress_ returns a null close rate when nothing is logged — "we do not know" is not "you closed nothing"', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const r = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  r[col['Rep'] - 1] = 'Sean';
  r[col['Call Type'] - 1] = 'Sales Call';
  r[col['Call Date'] - 1] = new gas.Date('2026-09-09T10:00:00Z');
  const p = gas.computeGoalProgress_([r], col, 'Sean',
    new gas.Date('2026-09-07T00:00:00Z'), new gas.Date('2026-09-14T00:00:00Z'), gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(p.closeRate, null);
  assert.equal(p.coverage, 0);
});

test('buildGoalProgressSection_ refuses to show a close rate while outcome coverage is thin', () => {
  // Outcome Disposition is hand-typed and mostly blank, so a rate computed
  // off one logged call out of five is noise — and a bare 0% would read as
  // "you closed nothing this week", which is a different claim.
  const thin = { salesCallsHeld: 5, salesCallsTarget: 4, dealsClosed: 0, dealsTarget: 1,
    outcomesLogged: 1, coverage: 0.2, closeRate: 0, closeRateTarget: 0.3 };
  const section = gas.buildGoalProgressSection_('Joana', thin);
  assert.ok(section.plain.indexOf('not enough outcomes logged') !== -1,
    'must say we cannot tell, rather than publishing a misleading rate');
  assert.ok(section.plain.indexOf('0%') === -1, 'a 0% close rate must not be shown on thin coverage');

  const solid = { salesCallsHeld: 4, salesCallsTarget: 4, dealsClosed: 1, dealsTarget: 1,
    outcomesLogged: 4, coverage: 1, closeRate: 0.25, closeRateTarget: 0.3 };
  const good = gas.buildGoalProgressSection_('Joana', solid);
  assert.ok(/25%/.test(good.plain) && /30%/.test(good.plain),
    'with real coverage, show the actual rate against the target');
  assert.ok(good.plain.indexOf('4 of 4') !== -1, 'hitting the call target should be visible');
});

test('buildGoalProgressSection_ gives Bens a lead-gen target derived from Joana\'s, and no closer metrics', () => {
  const p = { salesCallsHeld: 6, salesCallsTarget: 4, dealsClosed: 0, dealsTarget: 1,
    outcomesLogged: 0, coverage: 0, closeRate: null, closeRateTarget: 0.3 };
  const section = gas.buildGoalProgressSection_('Bens', p);
  assert.ok(section.plain.indexOf('Joana') !== -1, 'his target is expressed through the closer he feeds');
  assert.ok(section.plain.indexOf('4 sales calls a week') !== -1,
    'the derived number must be shown, not just the deal target');
  assert.ok(section.plain.indexOf('close rate') === -1 || section.plain.indexOf('Close rate:') === -1,
    'Bens is never scored on a close rate — he does not close');
  // And the honest caveat about what we cannot yet measure.
  assert.ok(section.plain.indexOf('activity, not your conversion') !== -1);

  // A rep with no goal defined gets no invented target.
  assert.equal(gas.buildGoalProgressSection_('Tomás', p), null);
});

test('Phase 7 grades a discovery drill, and its rubric enforces "don\'t take any answer as an answer"', () => {
  const prompt = gas.buildDailyPracticeSystemPrompt_('Bens');
  assert.ok(/drill_type is "discovery"/.test(prompt), 'discovery must be a recognised drill type');
  assert.ok(prompt.indexOf('don\'t take any answer as an answer') !== -1 ||
    prompt.indexOf('take any answer as an answer') !== -1,
    'the follow-up rule is the point of the drill and must be in the anchors');
  // A rep who asks one good question and moves on tops out at 4, not 5.
  assert.ok(prompt.indexOf('accepted the first answer') !== -1,
    'accepting the first answer must be explicitly capped below a 5');
  assert.ok(/"drill_type": "objection \| close_ask \| framework \| discovery"/.test(prompt),
    'the JSON shape must offer discovery');
});

test('isValidPracticeSchema_ accepts a discovery drill alongside the three existing types', () => {
  const base = {
    reasoning: 'r', drill_type: 'discovery', objection_type: 'n/a', framework_topic: 'n/a',
    technique_used: true, technique_description: 'asked for a number, then followed up',
    delivery_quality: 'confident', overall_score: 4, sharpen_next: 'x', feedback_summary: 'y'
  };
  assert.equal(gas.isValidDailyPracticeSchema_(base), true, 'discovery must be a valid drill_type');
  assert.equal(gas.isValidDailyPracticeSchema_(Object.assign({}, base, { drill_type: 'nonsense' })), false,
    'an unknown drill_type must still be rejected');
});

test('Bens and QC rubrics now score goal and pain — the gap found on Bens\' 09/09 training call', () => {
  // Tomás: "it's the most important thing is, like, knowing the goal, knowing
  // the pain." Neither variant scored either one until 09/09/2026, so the
  // single dimension the trainer cares most about was invisible on every
  // ICONS 100 interview and every QC anyone ran.
  [['bens', gas.buildBensJudgeSystemPrompt_()], ['qc', gas.buildQcJudgeSystemPrompt_()]].forEach(([name, prompt]) => {
    assert.ok(/uncovered_goal/.test(prompt), name + ': must ask for uncovered_goal');
    assert.ok(/uncovered_pain/.test(prompt), name + ': must ask for uncovered_pain');
    // The definition must be the shared one, not a re-worded copy that can drift.
    assert.ok(prompt.indexOf('running TOWARDS') !== -1 && prompt.indexOf('running FROM') !== -1,
      name + ': must carry the shared goal/pain definition verbatim');
    assert.ok(prompt.indexOf('is a condition, not') !== -1,
      name + ': must keep Tomás\'s correction that a numeric shortfall is not a pain');
  });
});

test('the Bens rubric scopes discovery DEPTH to a podcast recording, so he is never coached towards a 30-minute discovery', () => {
  const prompt = gas.buildBensJudgeSystemPrompt_();
  assert.ok(prompt.indexOf('not a discovery call') !== -1,
    'the interview depth caveat must be present');
  assert.ok(prompt.indexOf('pre-call research') !== -1,
    'research must be an accepted route to the goal/pain on an interview');
  assert.ok(prompt.indexOf('a light touch is not the same as no touch') !== -1,
    'a rep who surfaced neither still fails — the caveat must not become a free pass');
  // The QC rubric must NOT carry the interview caveat: a QC is where real
  // discovery is supposed to happen.
  assert.ok(gas.buildQcJudgeSystemPrompt_().indexOf('not a discovery call') === -1,
    'the light-touch caveat must not leak into the QC rubric');
});

test('every rubric variant screens out part-time agents (Tomás, 09/09/2026: "we don\'t work with people that are not full-time real estate agents")', () => {
  // The post-sale Discovery variant is deliberately excluded — see the
  // dedicated test above. Every PRE-sale variant must carry the rule.
  const variants = {
    shared: gas.buildJudgeSystemPrompt_(),
    bens: gas.buildBensJudgeSystemPrompt_(),
    qc: gas.buildQcJudgeSystemPrompt_(),
    sean: gas.buildSeanJudgeSystemPrompt_(),
    tomas: gas.buildTomasJudgeSystemPrompt_()
  };
  Object.keys(variants).forEach((name) => {
    assert.ok(variants[name].indexOf('FULL-TIME real estate agents') !== -1,
      name + ': the full-time qualification rule must reach every variant, so it cannot drift between reps');
    // ...but an unasked question must never become a verdict against the lead.
    assert.ok(variants[name].indexOf('do not invent it') !== -1,
      name + ': an unestablished full-time status must be a coaching point, not a screen-out');
  });
});

test('QC/Discovery calls are not scored on framework explanation — that is the Sales Call\'s job, not a pre-sales qualification call\'s (Kris, 31/08/2026)', () => {
  // buildQcJudgeSystemPrompt_ must not ask the model for a framework object
  // or offer framework_not_explained as a primary_failure_mode — both would
  // encourage the model to invent/penalize something this call type was
  // never meant to cover.
  const prompt = gas.buildQcJudgeSystemPrompt_();
  assert.doesNotMatch(prompt, /"framework":/, 'the QC judge schema must not ask for a framework object');
  assert.doesNotMatch(prompt, /framework_not_explained/, 'framework_not_explained must not be offered as a QC primary_failure_mode');

  // A real (post-fix) QC judge result has no `framework` key at all — the
  // schema validator must accept that, not require one.
  const qcResultNoFramework = perfectQcResult_();
  delete qcResultNoFramework.framework;
  qcResultNoFramework.lead_quality = { verdict: 'good_to_book', justification: 'ok' };
  qcResultNoFramework.root_cause_if_no_booking = 'N/A';
  qcResultNoFramework.manual_review_recommended = false;
  qcResultNoFramework.severity = 1;
  assert.equal(gas.isValidQcJudgeSchema_(qcResultNoFramework), true);

  // writeScoreToRow_ must leave Flag: Framework Explained / Framework Gaps
  // untouched (blank/"no signal") for a qc-variant row, never derive a
  // fabricated "explained: false, gaps: all three" from the missing object.
  const cells = {};
  const fakeSheet = { getRange(row, col) { return { setValue(v) { cells[row + ':' + col] = v; return this; } }; } };
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const result = qcResultNoFramework;
  result.manual_review_recommended = false;
  result.severity = 1;
  result.feedback_summary = 'qc no-framework summary';
  result.primary_failure_mode = 'none';
  gas.writeScoreToRow_(fakeSheet, 4, col, result, false, 'Some Prospect', 'qc');
  assert.equal(cells['4:' + col['Flag: Framework Explained']], undefined,
    'writeScoreToRow_ must not write a Flag: Framework Explained value for the qc variant');
  assert.equal(cells['4:' + col['Framework Gaps']], undefined,
    'writeScoreToRow_ must not write a Framework Gaps value for the qc variant');

  // The shadow-mode analytic score must not deduct for a missing framework
  // object either — computeQcAnalyticScore_ used to call
  // deriveFrameworkFields_(result), which treats an absent `framework` key
  // as "nothing explained" and silently docked a point from every real QC
  // call once the judge stopped returning that field.
  assert.equal(gas.computeQcAnalyticScore_(qcResultNoFramework), 5,
    'a QC result with no framework object must score a perfect 5, not be docked for a dimension it is not scored on');
});

test('every judge system prompt asks the model to \\n-separate distinct ideas within feedback_summary, not chain them into one dense paragraph (Kris\'s real complaint 31/08/2026 on Sean\'s weekly scorecard: a wall of text with no line breaks at all)', () => {
  var prompts = [
    gas.buildJudgeSystemPrompt_(),
    gas.buildBensJudgeSystemPrompt_(),
    gas.buildQcJudgeSystemPrompt_(),
    gas.buildSeanJudgeSystemPrompt_(),
    gas.buildTomasJudgeSystemPrompt_()
  ];
  prompts.forEach(function (p, i) {
    assert.match(p, /separated by a literal \\n/,
      'judge prompt #' + i + ' must instruct the model to \\n-separate multi-idea feedback_summary text');
  });
});

// --- Task: analytic (deterministic) score shadow-mode rollup (25/08/2026) ---
// QA_COACHING_RESEARCH_REPORT.md §1.4 — computes a second, deterministic
// call_quality_score from the boolean flags/framework the model already
// outputs, purely to log alongside the model's own pick for comparison.
// SHADOW MODE ONLY: see ANALYTIC_SCORE_CONFIG and the "still changes nothing
// live" test at the very end of this section.

/** Minimal all-true flags/framework object, per variant, so each test only has to flip what it cares about. */
function perfectSharedResult_() {
  return {
    call_quality_score: 5,
    flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true }
  };
}
function perfectSeanResult_() {
  return {
    call_quality_score: 5,
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      discovery_adequate: true, understood_leads_business: true,
      captured_leads_goals: true, tied_framework_to_goals: true,
      booked_second_call_with_tomas: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true }
  };
}
function perfectBensResult_() {
  return {
    call_quality_score: 5,
    call_role: 'icons_100_interview',
    next_step_type: 'Sales Call',
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      booked_next_step: true, discovery_adequate: true, understood_leads_business: true,
      uncovered_goal: true, uncovered_pain: true,
      interview_content_quality_good: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true }
  };
}
function perfectTomasResult_() {
  return {
    call_quality_score: 5,
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      followed_goal_mirror_map_proof_process: true, stalling_converted_to_date: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true }
  };
}
function perfectQcResult_() {
  return {
    call_quality_score: 5,
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      booked_next_step: true, discovery_adequate: true, understood_leads_business: true,
      uncovered_goal: true, uncovered_pain: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true }
  };
}

test('clampAnalyticScore_ enforces the 1-5 floor/ceiling under extreme raw values', () => {
  assert.equal(gas.clampAnalyticScore_(10), 5);
  assert.equal(gas.clampAnalyticScore_(-3), 1);
  assert.equal(gas.clampAnalyticScore_(0), 1);
  assert.equal(gas.clampAnalyticScore_(3), 3);
});

test('computeSharedAnalyticScore_ scores a perfect call 5', () => {
  assert.equal(gas.computeSharedAnalyticScore_(perfectSharedResult_()), 5);
});

test('computeSharedAnalyticScore_ core requirement: a close-ask miss alone is weighted double a same-count non-close miss', () => {
  const perfect = perfectSharedResult_();
  const closeMissOnly = perfectSharedResult_();
  closeMissOnly.flags.asked_for_close = false;
  const objectionsMissOnly = perfectSharedResult_();
  objectionsMissOnly.flags.objections_uncovered = false; // partial miss (uncovered false) already counts as a miss

  const perfectScore = gas.computeSharedAnalyticScore_(perfect);
  const closeMissScore = gas.computeSharedAnalyticScore_(closeMissOnly);
  const objectionsMissScore = gas.computeSharedAnalyticScore_(objectionsMissOnly);

  assert.equal(perfectScore, 5);
  assert.equal(perfectScore - closeMissScore, 2, 'a close-ask miss alone must cost 2 full points off a perfect call');
  assert.equal(perfectScore - objectionsMissScore, 1, 'a same-count non-close miss must cost only 1 point off a perfect call');
  assert.ok(closeMissScore < objectionsMissScore, 'a close-ask miss must score strictly lower than an equal-count non-close miss');
});

test('computeSharedAnalyticScore_ framework-not-explained miss alone deducts 1', () => {
  const frameworkMissOnly = perfectSharedResult_();
  // Reversed 08/09/2026: a leg the rep deliberately left out is no longer a
  // miss at all (Tomás: "It's never going to be all of them"). What fails the
  // dimension now is delivering a framework that doesn't fit the lead.
  frameworkMissOnly.framework.framework_matched_to_lead = false;
  assert.equal(gas.computeSharedAnalyticScore_(frameworkMissOnly), 4);
});

test('computeSharedAnalyticScore_ delivery-ineffective miss alone deducts 1, same weight as framework (29/08/2026)', () => {
  const deliveryMissOnly = perfectSharedResult_();
  deliveryMissOnly.delivery.adapted_to_lead_engagement = false; // either gap alone is enough to fail deriveDeliveryFields_'s "effective"
  assert.equal(gas.computeSharedAnalyticScore_(deliveryMissOnly), 4);
});

test('computeSharedAnalyticScore_ floors at 1 when every deduction fires', () => {
  const worst = perfectSharedResult_();
  worst.flags.asked_for_close = false;
  worst.flags.objections_uncovered = false;
  worst.framework.framework_matched_to_lead = false;
  assert.equal(gas.computeSharedAnalyticScore_(worst), 1);
});

test('computeSeanAnalyticScore_ scores a perfect call 5', () => {
  assert.equal(gas.computeSeanAnalyticScore_(perfectSeanResult_()), 5);
});

test('computeSeanAnalyticScore_ OR-close condition: either asked_for_close or booked_second_call_with_tomas satisfies the close requirement', () => {
  const askedOnly = perfectSeanResult_();
  askedOnly.flags.booked_second_call_with_tomas = false; // asked_for_close still true
  const bookedOnly = perfectSeanResult_();
  bookedOnly.flags.asked_for_close = false; // booked_second_call_with_tomas still true
  const neitherAskedNorBooked = perfectSeanResult_();
  neitherAskedNorBooked.flags.asked_for_close = false;
  neitherAskedNorBooked.flags.booked_second_call_with_tomas = false;

  assert.equal(gas.computeSeanAnalyticScore_(askedOnly), 5, 'asked_for_close alone should satisfy the OR');
  assert.equal(gas.computeSeanAnalyticScore_(bookedOnly), 5, 'booked_second_call_with_tomas alone should satisfy the OR');
  assert.equal(gas.computeSeanAnalyticScore_(neitherAskedNorBooked), 3, 'neither path satisfied should cost the full -2');
});

test('computeSeanAnalyticScore_ discovery/goal-alignment is one combined bucket, not four separate deductions', () => {
  const oneGap = perfectSeanResult_();
  oneGap.flags.captured_leads_goals = false;
  const allFourGaps = perfectSeanResult_();
  allFourGaps.flags.discovery_adequate = false;
  allFourGaps.flags.understood_leads_business = false;
  allFourGaps.flags.captured_leads_goals = false;
  allFourGaps.flags.tied_framework_to_goals = false;

  assert.equal(gas.computeSeanAnalyticScore_(oneGap), 4, 'a single gap in the bucket should cost exactly 1 point');
  assert.equal(gas.computeSeanAnalyticScore_(allFourGaps), 4, 'all four gaps together should still cost only 1 point (one bucket, not four)');
});

test('computeBensAnalyticScore_ scores a perfect call 5', () => {
  assert.equal(gas.computeBensAnalyticScore_(perfectBensResult_()), 5);
});

test('computeBensAnalyticScore_ asked-but-not-booked vs never-asked does not double-penalize the same underlying failure', () => {
  const neverAsked = perfectBensResult_();
  neverAsked.flags.asked_for_close = false;
  neverAsked.flags.booked_next_step = false;

  const askedButNotBooked = perfectBensResult_();
  askedButNotBooked.flags.booked_next_step = false; // asked_for_close stays true

  const neverAskedScore = gas.computeBensAnalyticScore_(neverAsked);
  const askedButNotBookedScore = gas.computeBensAnalyticScore_(askedButNotBooked);

  assert.equal(neverAskedScore, 3, 'never asking costs only the -2 close-ask deduction, not also the booking deduction');
  assert.equal(askedButNotBookedScore, 4, 'asking but not booking costs only the -1 booking deduction');
  assert.ok(askedButNotBookedScore > neverAskedScore, 'never asking must still be worse than asking-but-not-booking');
});

test('computeBensAnalyticScore_ QC-vs-Sales-Call deduction only applies to icons_100_interview, never to a qc-role call', () => {
  const interviewBookedQC = perfectBensResult_();
  interviewBookedQC.call_role = 'icons_100_interview';
  interviewBookedQC.next_step_type = 'QC';

  const interviewBookedSalesCall = perfectBensResult_();
  interviewBookedSalesCall.call_role = 'icons_100_interview';
  interviewBookedSalesCall.next_step_type = 'Sales Call';

  const qcRoleBookedQC = perfectBensResult_();
  qcRoleBookedQC.call_role = 'qc';
  qcRoleBookedQC.next_step_type = 'QC';

  assert.equal(gas.computeBensAnalyticScore_(interviewBookedQC), 4, 'an interview call that only books a QC should lose 1 point');
  assert.equal(gas.computeBensAnalyticScore_(interviewBookedSalesCall), 5, 'an interview call that books the Sales Call directly should not lose this point');
  assert.equal(gas.computeBensAnalyticScore_(qcRoleBookedQC), 5, 'a qc-role call booking a QC is its normal next step — this deduction must not fire for qc role');
});

test('computeTomasAnalyticScore_ scores a perfect call 5, and each single deduction matches the shared weights', () => {
  assert.equal(gas.computeTomasAnalyticScore_(perfectTomasResult_()), 5);

  const closeMiss = perfectTomasResult_();
  closeMiss.flags.asked_for_close = false;
  assert.equal(gas.computeTomasAnalyticScore_(closeMiss), 3);

  const objectionsMiss = perfectTomasResult_();
  objectionsMiss.flags.objections_overcome = false;
  assert.equal(gas.computeTomasAnalyticScore_(objectionsMiss), 4);

  const frameworkMiss = perfectTomasResult_();
  frameworkMiss.framework.framework_matched_to_lead = false;
  assert.equal(gas.computeTomasAnalyticScore_(frameworkMiss), 4);
});

test('computeTomasAnalyticScore_ deducts 1 for the combined Tomas_Playbook.md bucket (goal/mirror/map/proof process + converting a stall into a specific date), same "one combined bucket" pattern as Sean\'s discovery/goal-alignment extras (29/08/2026)', () => {
  const processMiss = perfectTomasResult_();
  processMiss.flags.followed_goal_mirror_map_proof_process = false;
  assert.equal(gas.computeTomasAnalyticScore_(processMiss), 4);

  const stallMiss = perfectTomasResult_();
  stallMiss.flags.stalling_converted_to_date = false;
  assert.equal(gas.computeTomasAnalyticScore_(stallMiss), 4, 'a single missed flag in the bucket still only deducts 1, not 2');

  const bothMiss = perfectTomasResult_();
  bothMiss.flags.followed_goal_mirror_map_proof_process = false;
  bothMiss.flags.stalling_converted_to_date = false;
  assert.equal(gas.computeTomasAnalyticScore_(bothMiss), 4, 'both flags missing is still the same single combined deduction, not two');
});

test('computeQcAnalyticScore_ scores a perfect QC/Discovery call 5, and mirrors Bens\' deduction weights minus the interview-only one (29/08/2026)', () => {
  assert.equal(gas.computeQcAnalyticScore_(perfectQcResult_()), 5);

  const closeMiss = perfectQcResult_();
  closeMiss.flags.asked_for_close = false;
  assert.equal(gas.computeQcAnalyticScore_(closeMiss), 3, 'a missed close-ask is the #1 mistake, -2, same weight as every other variant');

  const askedButNotBooked = perfectQcResult_();
  askedButNotBooked.flags.booked_next_step = false;
  assert.equal(gas.computeQcAnalyticScore_(askedButNotBooked), 4, 'asked but not booked is a separate -1, only when he actually asked');

  const neverAskedNeverBooked = perfectQcResult_();
  neverAskedNeverBooked.flags.asked_for_close = false;
  neverAskedNeverBooked.flags.booked_next_step = false;
  assert.equal(gas.computeQcAnalyticScore_(neverAskedNeverBooked), 3, 'never asking must not be double-penalized on top of its own -2');

  const discoveryMiss = perfectQcResult_();
  discoveryMiss.flags.understood_leads_business = false;
  assert.equal(gas.computeQcAnalyticScore_(discoveryMiss), 4);
});

test('computeAnalyticScore_ dispatches to the matching per-variant function, defaulting unknown variants to shared', () => {
  assert.equal(gas.computeAnalyticScore_('sean', perfectSeanResult_()), 5);
  assert.equal(gas.computeAnalyticScore_('bens', perfectBensResult_()), 5);
  assert.equal(gas.computeAnalyticScore_('tomas', perfectTomasResult_()), 5);
  assert.equal(gas.computeAnalyticScore_('qc', perfectQcResult_()), 5);
  assert.equal(gas.computeAnalyticScore_('shared', perfectSharedResult_()), 5);
  assert.equal(gas.computeAnalyticScore_('nonsense-unknown-variant', perfectSharedResult_()), 5);
});

test('logAnalyticScoreShadowCheck_ logs only when the model and analytic scores differ by more than 1 point, and always returns the analytic score', () => {
  const originalLog = gas.Logger.log;
  const lines = [];
  gas.Logger.log = (msg) => { lines.push(msg); };
  try {
    const bigDivergence = perfectSharedResult_(); // analytic = 5
    bigDivergence.call_quality_score = 1; // model said 1, diff = 4
    const returned = gas.logAnalyticScoreShadowCheck_('Test Prospect', 'shared', bigDivergence);
    assert.equal(returned, 5);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Analytic score shadow-check/);
    assert.match(lines[0], /Test Prospect/);
    assert.match(lines[0], /model=1/);
    assert.match(lines[0], /analytic=5/);
    assert.match(lines[0], /diff 4/);

    lines.length = 0;
    const closeAgreement = perfectSharedResult_(); // analytic = 5
    closeAgreement.call_quality_score = 4; // diff = 1, within tolerance
    gas.logAnalyticScoreShadowCheck_('Another Prospect', 'shared', closeAgreement);
    assert.equal(lines.length, 0, 'a diff of exactly 1 should not log — matches diffRegressionResult_\'s existing "normal judge noise" tolerance');
  } finally {
    gas.Logger.log = originalLog;
  }
});

test('ANALYTIC_SCORE_CONFIG ships disabled — shadow mode only, no live behavior change yet', () => {
  assert.equal(gas.ANALYTIC_SCORE_CONFIG.ENABLED, false);
});

test('writeScoreToRow_ still writes the MODEL\'s own call_quality_score, never the analytic score, even when they diverge (the shadow-mode safety guarantee)', () => {
  const cells = {};
  const fakeSheet = {
    getRange(row, col) {
      return { setValue(v) { cells[row + ':' + col] = v; return this; } };
    }
  };
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });

  const result = {
    lead_quality: { verdict: 'good_to_book' },
    call_quality_score: 5, // model says 5
    flags: { asked_for_close: false, objections_uncovered: false, objections_overcome: false }, // analytic would say 1
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false, framework_matched_to_lead: false },
    manual_review_recommended: false,
    severity: 1,
    feedback_summary: 'string',
    primary_failure_mode: 'multiple'
  };
  gas.writeScoreToRow_(fakeSheet, 9, col, result, false, 'Divergent Prospect');

  assert.equal(cells['9:' + col['Call Quality Score']], 5, 'the sheet must still receive the model\'s own score, not the analytic one');
});

test('buildDailyPracticeFeedbackEmail_ leads with the quoted feedback summary, keeps the score out of the subject and body lead', () => {
  const result = {
    drill_type: 'objection',
    objection_type: 'budget',
    technique_used: true,
    technique_description: 'Agree/Isolate/Repeat, then cited a case study.',
    delivery_quality: 'confident',
    overall_score: 4,
    sharpen_next: 'Slow down before repeating the objection back.',
    feedback_summary: '"I mean, it\'s just a lot of money right now" — you agreed and isolated it well, then landed a concrete case study.'
  };
  const email = gas.buildDailyPracticeFeedbackEmail_('Sean', '260823_objection_practice.mp4', result);

  assert.ok(email.subject.indexOf('4/5') === -1, 'subject should not lead with the numeric score');
  const quoteIdx = email.body.indexOf('a lot of money right now');
  const forTheRecordIdx = email.body.indexOf('For the record');
  const scoreIdx = email.body.indexOf('4/5');
  assert.ok(quoteIdx !== -1, 'expected the quoted feedback summary in the body');
  assert.ok(forTheRecordIdx !== -1, 'expected a "For the record" section');
  assert.ok(quoteIdx < forTheRecordIdx, 'quote should come before the numeric section');
  assert.ok(scoreIdx > forTheRecordIdx, 'score should come after the "For the record" marker');
  assert.ok(email.body.indexOf(result.sharpen_next) < forTheRecordIdx, 'the one behavior to change should also be above the fold');
});

test('dailyPracticeFeedbackDocName_ builds the same name dailyPracticeAlreadyGraded_ and deliverDailyPracticeGrading_ both rely on (real bug C-02: two independently-written copies of this string transform can drift and never recognize each other\'s output, re-grading the same file forever)', () => {
  // transcribe_daily_practice.py names the transcript doc with the video's
  // extension still embedded, e.g. "<video name>.mp4 — Transcript".
  assert.equal(gas.dailyPracticeFeedbackDocName_('260819_practice.mp4 — Transcript'), '260819_practice.mp4 — Feedback');
  assert.equal(gas.dailyPracticeFeedbackDocName_('260819_practice.mp4 - Transcript'), '260819_practice.mp4 — Feedback');
});

test('findDailyPracticeFollowupThreadForFile_ matches a dateStr Sheets stored as a Number, not a String (real bug H-03: a numeric-looking cell value like "260819" round-trips through Sheets as a Number, so a bare === against the string dateStr silently never matches)', () => {
  const rows = [
    ['Sean', 260819, 'thread-abc', 'open', '', 0] // dateStr stored/read back as a Number, exactly what Sheets does to a numeric-looking string cell
  ];
  const sheet = {
    getLastRow: () => rows.length + 1,
    getLastColumn: () => 8, // already has the "Matched File"/"Score" columns — no header migration needed
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => rows
    })
  };
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) };
  try {
    const threadId = gas.findDailyPracticeFollowupThreadForFile_('Sean', '260819_practice.mp4 — Transcript');
    assert.equal(threadId, 'thread-abc');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

test('sendDailyPracticeReminders_\'s lane rotation: day 1 (Wed) lands on lane index 0 (real bug L-12: label.day is 1-based against a 0-based lanes array, so a bare `day % length` never actually hit index 0 on the cycle\'s first day)', () => {
  const lanes = ['close_ask', 'framework', 'objection'];
  const dayToLane = (day) => lanes[(day - 1) % lanes.length];
  assert.equal(dayToLane(1), 'close_ask');
  assert.equal(dayToLane(2), 'framework');
  assert.equal(dayToLane(3), 'objection');
  assert.equal(dayToLane(4), 'close_ask');
});

test('repHasPracticeToday_ enforces per-rep practice-day cadence (Kris\'s ask 01/09/2026, after Joana said the daily cadence was hard to sustain alongside calls/emails/trackers/follow-ups/briefings)', () => {
  const original = gas.DAILY_PRACTICE_CONFIG.PRACTICE_DAYS;
  try {
    gas.DAILY_PRACTICE_CONFIG.PRACTICE_DAYS = {
      Joana: ['Tuesday', 'Thursday'],
      Bens: ['Monday', 'Wednesday', 'Thursday'],
      Sean: ['Monday', 'Wednesday', 'Thursday']
    };
    assert.equal(gas.repHasPracticeToday_('Joana', 'Tuesday'), true);
    assert.equal(gas.repHasPracticeToday_('Joana', 'Thursday'), true);
    assert.equal(gas.repHasPracticeToday_('Joana', 'Monday'), false);
    assert.equal(gas.repHasPracticeToday_('Joana', 'Wednesday'), false);
    assert.equal(gas.repHasPracticeToday_('Joana', 'Friday'), false);

    assert.equal(gas.repHasPracticeToday_('Bens', 'Monday'), true);
    assert.equal(gas.repHasPracticeToday_('Bens', 'Wednesday'), true);
    assert.equal(gas.repHasPracticeToday_('Bens', 'Thursday'), true);
    assert.equal(gas.repHasPracticeToday_('Bens', 'Tuesday'), false);
    assert.equal(gas.repHasPracticeToday_('Bens', 'Friday'), false);

    assert.equal(gas.repHasPracticeToday_('Sean', 'Monday'), true);
    assert.equal(gas.repHasPracticeToday_('Sean', 'Tuesday'), false);

    // A rep with no PRACTICE_DAYS entry at all must default to every
    // weekday — the original behavior, unchanged for anyone not opted in.
    assert.equal(gas.repHasPracticeToday_('SomeNewRep', 'Monday'), true);
    assert.equal(gas.repHasPracticeToday_('SomeNewRep', 'Sunday'), true);
  } finally {
    gas.DAILY_PRACTICE_CONFIG.PRACTICE_DAYS = original;
  }
});

// ---------------------------------------------------------------------------
// Compliance backlog (26/08/2026): checkRep_ used to only ever compare
// TODAY's calendar events against TODAY's tracker rows — an item flagged one
// day was never looked at again. These pin the persisted-backlog behavior:
// unresolved items carry forward with their ORIGINAL date, resolved items
// drop out once logged anywhere in the sheet (not just on their own date),
// and the email surfaces each item's own age rather than just today's date.
// ---------------------------------------------------------------------------

test('daysAgoLabel_ computes calendar-day age in business time, not a raw 24h-bucket diff', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const now = new Date('2026-08-26T20:00:00Z'); // mid-afternoon in America/New_York
  assert.equal(gas.daysAgoLabel_('26/08/2026', now, tz), 'today');
  assert.equal(gas.daysAgoLabel_('25/08/2026', now, tz), '1 day ago');
  assert.equal(gas.daysAgoLabel_('20/08/2026', now, tz), '6 days ago');
});

test('reconcileComplianceBacklog_ drops an item once a LOGGED row matches it anywhere in the sheet, keeps the rest', () => {
  const backlog = [
    { eventId: 'evt-1', title: 'QC / Russell Kubach', prospectGuess: 'Russell Kubach', attendeeEmails: [], callDateLabel: '25/08/2026', firstFlaggedAt: '2026-08-25T22:00:00.000Z' },
    { eventId: 'evt-2', title: 'QC / Nicole Freed', prospectGuess: 'Nicole Freed', attendeeEmails: [], callDateLabel: '25/08/2026', firstFlaggedAt: '2026-08-25T22:00:00.000Z' }
  ];
  // Russell's row got logged since, late, dated correctly — same event ID
  // this time because stampMatch_ already backfilled it the day it was
  // first flagged. Nicole's has nothing matching yet.
  const loggedRowsAnyDate = [
    { rowIndex: 7, prospect: 'russellkubach', email: '', eventId: 'evt-1', logged: true }
  ];
  const result = gas.reconcileComplianceBacklog_('Bens', backlog, loggedRowsAnyDate);
  assert.equal(result.length, 1);
  assert.equal(result[0].eventId, 'evt-2');
});

test('appendNewBacklogEntries_ carries the ORIGINAL call date, and never double-tracks the same event ID twice', () => {
  gas.Utilities = { formatDate: () => '09:00' };
  const backlog = [
    { eventId: 'evt-1', title: 'QC / Russell Kubach', prospectGuess: 'Russell Kubach', attendeeEmails: [], callDateLabel: '24/08/2026', firstFlaggedAt: '2026-08-24T22:00:00.000Z' }
  ];
  const missingToday = [
    { id: 'evt-1', title: 'QC / Russell Kubach', prospectGuess: 'Russell Kubach', attendeeEmails: [], start: new Date('2026-08-26T13:00:00Z') }, // still unlogged, already tracked
    { id: 'evt-3', title: 'QC / Joseph Bradley', prospectGuess: 'Joseph Bradley', attendeeEmails: [], start: new Date('2026-08-26T13:00:00Z') } // genuinely new
  ];
  const result = gas.appendNewBacklogEntries_(backlog, missingToday, '26/08/2026', gas.CONFIG.BUSINESS_TIMEZONE, '2026-08-26T22:00:00.000Z');

  assert.equal(result.length, 2, 'evt-1 must not be duplicated');
  const russell = result.find((e) => e.eventId === 'evt-1');
  assert.equal(russell.callDateLabel, '24/08/2026', 'a still-open item must keep its ORIGINAL flagged date, not today\'s');
  const joseph = result.find((e) => e.eventId === 'evt-3');
  assert.equal(joseph.callDateLabel, '26/08/2026', 'a genuinely new item is dated today');
});

test('buildPlaybookReviewNewMaterialEmail_ produces a styled htmlBody — bold prospect/score, colored score, italicized quotes, no raw wall of text (Kris\'s ask 02/09/2026: "No colour, no bold, no italic, big blocks of text")', () => {
  const repCfg = { name: 'Sean' };
  const flagged = [
    { prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 4, feedback: 'Sean said "when would you have 45 minutes" and locked the meeting.' },
    { prospectName: 'Andrew Coppens', callDate: '28/08/2026', score: 2, feedback: 'Andrew said "not interested at this point" and Sean never countered it.' }
  ];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026');

  assert.ok(email.htmlBody, 'must include an htmlBody, not plain text only');
  assert.ok(email.htmlBody.indexOf('<strong>1. Bruce Henson</strong>') !== -1, 'prospect name should be bold');
  assert.ok(email.htmlBody.indexOf('<strong style="color:' + gas.dailyPracticeScoreColor_(4) + ';">4</strong>') !== -1,
    'score 4 should use the shared score-color rubric, not a new one');
  assert.ok(email.htmlBody.indexOf('<strong style="color:' + gas.dailyPracticeScoreColor_(2) + ';">2</strong>') !== -1,
    'score 2 should be colored differently than score 4 (dailyPracticeScoreColor_ reused, not reinvented)');
  assert.ok(email.htmlBody.indexOf('<i>&quot;when would you have 45 minutes&quot;</i>') !== -1,
    'quoted transcript excerpts should be italicized, same as the Practice Drill Feedback email');
  assert.ok(email.htmlBody.indexOf('<div') !== -1, 'each call should render as its own visually distinct block, not one dense paragraph');
});

test('rankTrainingPriorities_ ranks the four elements by how many calls failed each, so a recurring gap outranks one bad call (Kris 03/09/2026: "All 4 need to be graded and the highest priority trained each week")', () => {
  const call = (score, flags) => ({ score: score, flags: flags });
  // Discovery fails 3 of 4; objections fail 1; the ask fails 2.
  const calls = [
    call(2, { discovery: false, framework: true, ask: false, objections: true }),
    call(3, { discovery: false, framework: true, ask: true, objections: true }),
    call(2, { discovery: false, framework: true, ask: false, objections: false }),
    call(5, { discovery: true, framework: true, ask: true, objections: true })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  assert.equal(ranking[0].key, 'discovery', 'the element failed by the most calls is the week\'s focus');
  assert.equal(ranking[0].failed, 3);
  assert.equal(ranking[0].scored, 4);
  assert.equal(ranking[0].failedCalls.length, 3, 'the focus carries its own failing calls for the email to list');
  assert.equal(ranking[1].key, 'ask');
  assert.equal(ranking[3].key, 'framework', 'an element nothing failed sorts last');
  assert.equal(ranking[3].failed, 0);
});

test('rankTrainingPriorities_ treats a blank flag as "no signal" — never as a failure — so a QC call (framework not scored) and rows predating a column cannot manufacture a training focus nobody was graded on', () => {
  const calls = [
    // Two QC calls: framework legitimately never scored on these.
    { score: 4, flags: { discovery: true, framework: null, ask: true, objections: true } },
    { score: 4, flags: { discovery: true, framework: null, ask: true, objections: false } }
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const framework = ranking.filter((r) => r.key === 'framework')[0];
  assert.equal(framework.failed, 0, 'an ungraded element must never count as failed');
  assert.equal(framework.scored, 0, 'and must not inflate the denominator either');
  assert.equal(ranking[0].key, 'objections', 'the only real failure is the focus');
  assert.equal(ranking[0].scored, 2, 'objections were graded on both calls');
});

test('rankTrainingPriorities_ never surfaces a SOLD call as "where the rep failed" — real bug, Tomás on Slack 08/09/2026: "Stacie Staub is signaled as a 2/5 and this was the lead Joana closed by herself. Never even met the lady." SO training adjust to the success.\'', () => {
  const calls = [
    // Stacie Staub: failed two flags on paper, but the lead closed. Must
    // never appear in failedCalls or count toward the failed tally.
    { score: 2, outcomeDisposition: 'Sold',
      flags: { discovery: false, framework: true, ask: false, objections: true } },
    // A genuine failure on the same element, not sold — must still count.
    { score: 2, outcomeDisposition: '',
      flags: { discovery: false, framework: true, ask: true, objections: true } },
    { score: 5, outcomeDisposition: 'Not Sold',
      flags: { discovery: true, framework: true, ask: true, objections: true } }
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const discovery = ranking.filter((r) => r.key === 'discovery')[0];
  const ask = ranking.filter((r) => r.key === 'ask')[0];

  assert.equal(discovery.failed, 1, 'the sold call\'s discovery failure must not count');
  assert.equal(discovery.failedCalls.length, 1);
  assert.equal(discovery.failedCalls[0].outcomeDisposition, '', 'the surviving failedCall must be the one that was NOT sold');

  assert.equal(ask.failed, 0, 'the only ask failure was on the sold call, so ask has none left');

  // scored (the element WAS graded on this call) stays unaffected — only
  // whether it counts as a FAILURE changes, not whether it was graded.
  assert.equal(discovery.scored, 3);
});

test('rankTrainingPriorities_ breaks a tie toward the element whose failing calls scored worse', () => {
  const calls = [
    // discovery and objections each fail exactly 2 calls, but discovery's fail at 1-2 and objections' at 4-5.
    { score: 1, flags: { discovery: false, framework: true, ask: true, objections: true } },
    { score: 2, flags: { discovery: false, framework: true, ask: true, objections: true } },
    { score: 4, flags: { discovery: true, framework: true, ask: true, objections: false } },
    { score: 5, flags: { discovery: true, framework: true, ask: true, objections: false } }
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  assert.equal(ranking[0].failed, ranking[1].failed, 'precondition: this is a genuine tie on count');
  assert.equal(ranking[0].key, 'discovery', 'the worse-scoring failures win the tie');
  assert.equal(ranking[0].avgFailedScore, 1.5);
});

test('buildPlaybookReviewNewMaterialEmail_ leads with the week\'s focus and shows all four elements, so the pick is visible rather than asserted', () => {
  const repCfg = { name: 'Joana' };
  const flagged = [{
    prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 2, feedback: 'ok',
    gaps: { discovery: 'confirming/deepening what the earlier call surfaced' }
  }];
  const ranking = [
    { key: 'discovery', label: 'Discovery', failed: 3, scored: 4, avgFailedScore: 2, failedCalls: flagged },
    { key: 'objections', label: 'Objection handling', failed: 1, scored: 4, avgFailedScore: 3, failedCalls: [] },
    { key: 'ask', label: 'Asking for the money / the booking', failed: 0, scored: 4, avgFailedScore: null, failedCalls: [] },
    { key: 'framework', label: 'Framework explanation', failed: 0, scored: 0, avgFailedScore: null, failedCalls: [] }
  ];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026', ranking);

  assert.equal(email.subject, 'Joana — discovery is this week\'s focus (24/08 - 30/08)');
  assert.ok(email.body.indexOf('failed on 3 of 4') !== -1, 'plain body states the focus and its rate');
  assert.ok(email.body.indexOf('Objection handling: failed 1 of 4') !== -1, 'plain body shows the other elements too');
  assert.ok(email.body.indexOf('Framework explanation: not graded on any call last week') !== -1,
    'an element graded on nothing is said to be ungraded, not shown as a clean pass it did not earn');
  assert.ok(email.htmlBody.indexOf('This week\'s training focus for Joana: Discovery') !== -1,
    'htmlBody leads with the focus');
  // The Gaps column detail is the difference between "discovery was weak" and
  // "he never confirmed what the QC already surfaced".
  assert.ok(email.body.indexOf('Missing: confirming/deepening what the earlier call surfaced') !== -1,
    'plain body names which sub-piece failed');
  assert.ok(email.htmlBody.indexOf('confirming/deepening what the earlier call surfaced') !== -1,
    'htmlBody names which sub-piece failed');
});

test('buildPlaybookReviewNewMaterialEmail_ subject drops the year (Kris\'s ask 02/09/2026: "we know what year it is"), but the body keeps full dates', () => {
  const repCfg = { name: 'Sean' };
  const flagged = [{ prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 4, feedback: 'ok' }];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026');

  // Subject now names the week's training focus (03/09/2026) rather than a
  // generic "calls to review" — the year-stripping it pins is unchanged.
  assert.equal(email.subject, 'Sean — objection handling is this week\'s focus (24/08 - 30/08)');
  assert.ok(email.body.indexOf('24/08/2026 - 30/08/2026') !== -1, 'body should keep the full year, unlike the subject');
});

test('buildPlaybookReviewNewMaterialEmail_ links each flagged call to its transcript and Sales Call Log row (Kris\'s ask 02/09/2026: "if you want calls reviewed, add the links")', () => {
  const repCfg = { name: 'Sean' };
  const flagged = [{
    prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 4, feedback: 'ok',
    transcriptUrl: 'https://docs.google.com/document/d/abc123/edit',
    rowLink: 'https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=999&range=A5'
  }];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026');

  assert.ok(email.body.indexOf('https://docs.google.com/document/d/abc123/edit') !== -1, 'plain body should include the transcript link');
  assert.ok(email.body.indexOf('range=A5') !== -1, 'plain body should include the sheet row link');
  assert.ok(email.htmlBody.indexOf('href="https://docs.google.com/document/d/abc123/edit"') !== -1, 'htmlBody should link the transcript');
  assert.ok(email.htmlBody.indexOf('range=A5') !== -1, 'htmlBody should link the sheet row');
});

test('buildPlaybookReviewNewMaterialEmail_ handles a flagged call with no transcript/row link without breaking (e.g. an older row scored before those columns existed)', () => {
  const repCfg = { name: 'Sean' };
  const flagged = [{ prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 4, feedback: 'ok' }];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026');
  assert.equal(email.body.indexOf('undefined'), -1);
  assert.equal(email.htmlBody.indexOf('undefined'), -1);
});

test('buildPlaybookReviewNoNewCallsEmail_ names the scheduled topic when given one, and stays generic without it', () => {
  const withSchedule = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Sean' }, '24/08/2026 - 30/08/2026', { label: 'Discovery' }, 4);
  assert.equal(withSchedule.subject, 'Sean — no flagged calls last week');
  assert.ok(withSchedule.body.indexOf('scheduled topic is "Discovery"') !== -1);

  const withoutSchedule = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Bens' }, '24/08/2026 - 30/08/2026', null, 4);
  assert.ok(withoutSchedule.body.indexOf('none of the graded elements failed') !== -1);
  assert.equal(withoutSchedule.body.indexOf('scheduled topic'), -1);
});

test('buildPlaybookReviewNoNewCallsEmail_ distinguishes "had calls, none flagged" from "no calls at all" (real question, live 08/09/2026: "Why are Bens empty?" -- the two used to read identically)', () => {
  const someCalls = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Bens' }, '24/08/2026 - 30/08/2026', null, 3);
  assert.ok(someCalls.body.indexOf('3 call(s) logged for Bens') !== -1);
  assert.ok(someCalls.htmlBody.indexOf('3 call(s) logged for Bens') !== -1);

  const noCallsAtAll = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Bens' }, '24/08/2026 - 30/08/2026', null, 0);
  assert.ok(noCallsAtAll.body.indexOf('No calls logged for Bens at all') !== -1);
  assert.ok(noCallsAtAll.htmlBody.indexOf('No calls logged for Bens at all') !== -1);
});

// ---------------------------------------------------------------------------
// Playbook + training-recording links in the email itself (Kris's ask,
// 08/09/2026: "They need to be sent in the fucking email too! The email
// should also have a link of where Tomas puts the recording after the
// training.") — previously only lived on the dashboard page / the separate
// Tuesday transcript-reminder email.
// ---------------------------------------------------------------------------

test('playbookDashboardUrl_ points at the rep\'s own dashboard page, playbook anchor, URL-encoded for accented names', () => {
  assert.equal(gas.playbookDashboardUrl_('Sean'), gas.DASHBOARD_URL_ + 'reps/Sean#playbook');
  assert.equal(gas.playbookDashboardUrl_('Tomás'), gas.DASHBOARD_URL_ + 'reps/Tom%C3%A1s#playbook');
});

test('trainingRecordingFolderUrl_ returns the real Drive folder link for a rep that has one, null otherwise', () => {
  assert.equal(gas.trainingRecordingFolderUrl_('Sean'), 'https://drive.google.com/drive/folders/' + gas.TRAINING_REVIEW_CONFIG.FOLDERS.Sean);
  assert.equal(gas.trainingRecordingFolderUrl_('Bens'), 'https://drive.google.com/drive/folders/' + gas.TRAINING_REVIEW_CONFIG.FOLDERS.Bens);
  // Tomás has no training-call-recording folder of his own (he doesn't record a training call with himself).
  assert.equal(gas.trainingRecordingFolderUrl_('Tomás'), null);
  assert.equal(gas.trainingRecordingFolderUrl_('Nobody'), null);
});

test('playbookReviewLinksFooter_/playbookReviewLinksFooterHtml_ include the recording-folder link only when one exists for that rep', () => {
  const withFolder = gas.playbookReviewLinksFooter_('Sean');
  assert.ok(withFolder.indexOf('Playbook: ' + gas.playbookDashboardUrl_('Sean')) !== -1);
  assert.ok(withFolder.indexOf('training call recording here after the session') !== -1);

  const withoutFolder = gas.playbookReviewLinksFooter_('Tomás');
  assert.ok(withoutFolder.indexOf('Playbook: ' + gas.playbookDashboardUrl_('Tomás')) !== -1);
  assert.equal(withoutFolder.indexOf('training call recording'), -1);

  const htmlWithFolder = gas.playbookReviewLinksFooterHtml_('Sean');
  assert.ok(htmlWithFolder.indexOf('href="' + gas.playbookDashboardUrl_('Sean') + '"') !== -1);
  assert.ok(htmlWithFolder.indexOf('href="' + gas.trainingRecordingFolderUrl_('Sean') + '"') !== -1);
});

test('buildPlaybookReviewNewMaterialEmail_ includes the playbook + recording-folder links in both body and htmlBody', () => {
  const repCfg = { name: 'Sean' };
  const flagged = [{ prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 4, feedback: 'ok' }];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026');
  assert.ok(email.body.indexOf(gas.playbookDashboardUrl_('Sean')) !== -1);
  assert.ok(email.body.indexOf(gas.trainingRecordingFolderUrl_('Sean')) !== -1);
  assert.ok(email.htmlBody.indexOf(gas.playbookDashboardUrl_('Sean')) !== -1);
  assert.ok(email.htmlBody.indexOf(gas.trainingRecordingFolderUrl_('Sean')) !== -1);
});

test('buildPlaybookReviewNoNewCallsEmail_ includes the playbook + recording-folder links in both body and htmlBody', () => {
  const email = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Joana' }, '24/08/2026 - 30/08/2026', null, 4);
  assert.ok(email.body.indexOf(gas.playbookDashboardUrl_('Joana')) !== -1);
  assert.ok(email.body.indexOf(gas.trainingRecordingFolderUrl_('Joana')) !== -1);
  assert.ok(email.htmlBody.indexOf(gas.playbookDashboardUrl_('Joana')) !== -1);
  assert.ok(email.htmlBody.indexOf(gas.trainingRecordingFolderUrl_('Joana')) !== -1);
});

test('sendPlaybookReviewNoNewCallsEmail_ sends exactly what buildPlaybookReviewNoNewCallsEmail_ builds (body + htmlBody), to Tomás cc Kris (real risk after the buildX/sendX split: the two silently drifting apart)', () => {
  const originalGuardedSend = gas.guardedSend_;
  const calls = [];
  gas.guardedSend_ = (to, subject, body, opts, n) => { calls.push({ to, subject, body, opts, n }); return true; };
  try {
    const expected = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Sean' }, '24/08/2026 - 30/08/2026', { label: 'Discovery' }, 4);
    gas.sendPlaybookReviewNoNewCallsEmail_({ name: 'Sean' }, '24/08/2026 - 30/08/2026', { label: 'Discovery' }, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, gas.CONFIG.TOMAS_EMAIL);
    assert.equal(calls[0].subject, expected.subject);
    assert.equal(calls[0].body, expected.body);
    assert.equal(calls[0].opts.htmlBody, expected.htmlBody);
    assert.equal(calls[0].opts.cc, gas.CONFIG.KRIS_EMAIL);
  } finally {
    gas.guardedSend_ = originalGuardedSend;
  }
});

// ---------------------------------------------------------------------------
// Two-stage playbook review schedule (Kris's ask, 08/09/2026): Tomás trains
// from Portugal, Joana's first session is 10am Spain — so a reminder goes
// out at 8am Portugal (3am ET) and a final, recomputed confirmation at 10am
// Portugal (5am ET), so what's in his inbox right before the session
// reflects any last-minute override.
// ---------------------------------------------------------------------------

test('subjectPrefixForPlaybookStage_ prefixes only the reminder stage', () => {
  assert.equal(gas.subjectPrefixForPlaybookStage_('reminder'), '[Reminder] ');
  assert.equal(gas.subjectPrefixForPlaybookStage_('final'), '');
  assert.equal(gas.subjectPrefixForPlaybookStage_(undefined), '', 'no stage given must behave like "final" — the plain subject this function had before the two-stage schedule existed');
});

test('the Saturday draft goes to KRIS ONLY and carries the draft note; the Monday email goes to Tomás cc Kris, plain', () => {
  const originalGuardedSend = gas.guardedSend_;
  const calls = [];
  gas.guardedSend_ = (to, subject, body, opts) => { calls.push({ to, cc: opts.cc, subject, body, htmlBody: opts.htmlBody }); return true; };
  const repCfg = { name: 'Sean' };
  const flagged = [{ prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 4, feedback: 'ok' }];
  try {
    gas.sendPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026', [], null, 'draft');
    gas.sendPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026', [], null, 'final');
    assert.equal(calls.length, 2);

    // Saturday draft — Kris's tidy-up copy. Sending it to Tomás as well would
    // defeat the entire point of having a review day (Kris, 08/09/2026: "I get
    // up hours before you guys, so I can work on it so that it's tidier").
    assert.equal(calls[0].to, gas.CONFIG.KRIS_EMAIL, 'the draft is Kris-only');
    assert.ok(!calls[0].cc, 'the draft must not cc Tomás — he sees the reviewed one on Monday');
    assert.ok(calls[0].subject.indexOf('[Draft — Kris review] ') === 0);
    assert.ok(calls[0].body.indexOf('DRAFT') !== -1);
    assert.ok(calls[0].htmlBody.indexOf('DRAFT') !== -1);

    // Monday — the one Tomás actually works from.
    assert.equal(calls[1].to, gas.CONFIG.TOMAS_EMAIL);
    assert.equal(calls[1].cc, gas.CONFIG.KRIS_EMAIL);
    assert.equal(calls[1].subject.indexOf('[Draft'), -1, 'the Monday email keeps the plain, unprefixed subject');
    assert.equal(calls[1].body.indexOf('DRAFT'), -1);
  } finally {
    gas.guardedSend_ = originalGuardedSend;
  }
});

test('the no-new-calls email follows the same stage routing as the new-material one', () => {
  const originalGuardedSend = gas.guardedSend_;
  const calls = [];
  gas.guardedSend_ = (to, subject, body, opts) => { calls.push({ to, cc: opts.cc, subject, body }); return true; };
  try {
    gas.sendPlaybookReviewNoNewCallsEmail_({ name: 'Bens' }, '24/08/2026 - 30/08/2026', null, 4, 'draft');
    gas.sendPlaybookReviewNoNewCallsEmail_({ name: 'Bens' }, '24/08/2026 - 30/08/2026', null, 4, 'final');
    assert.equal(calls[0].to, gas.CONFIG.KRIS_EMAIL);
    assert.ok(calls[0].subject.indexOf('[Draft — Kris review] ') === 0);
    assert.ok(calls[0].body.indexOf('DRAFT') !== -1);
    assert.equal(calls[1].to, gas.CONFIG.TOMAS_EMAIL);
    assert.equal(calls[1].cc, gas.CONFIG.KRIS_EMAIL);
    assert.equal(calls[1].body.indexOf('DRAFT'), -1);
  } finally {
    gas.guardedSend_ = originalGuardedSend;
  }
});

test('the legacy "reminder" stage name still routes like a draft, so an old trigger or a manual call cannot silently email the team a raw draft', () => {
  const originalGuardedSend = gas.guardedSend_;
  const calls = [];
  gas.guardedSend_ = (to, subject, body, opts) => { calls.push({ to, cc: opts.cc, subject, body }); return true; };
  try {
    gas.sendPlaybookReviewNewMaterialEmail_({ name: 'Sean' }, [{ prospectName: 'X', callDate: '27/08/2026', score: 4, feedback: 'ok' }],
      '24/08/2026 - 30/08/2026', [], null, 'reminder');
    assert.ok(calls[0].body.indexOf('DRAFT') !== -1, 'an unrecognised-but-known legacy stage must still be treated as unreviewed');
  } finally {
    gas.guardedSend_ = originalGuardedSend;
  }
});

test('previewWeeklyPlaybookReview_ builds both the draft and final stages, not just one', () => {
  const originalBuild = gas.buildAndMaybeSendPlaybookReview_;
  const stagesSeen = [];
  gas.buildAndMaybeSendPlaybookReview_ = (forcePreview, stage) => { stagesSeen.push({ forcePreview, stage }); };
  try {
    gas.previewWeeklyPlaybookReview_();
    assert.deepEqual(stagesSeen, [{ forcePreview: true, stage: 'draft' }, { forcePreview: true, stage: 'final' }]);
  } finally {
    gas.buildAndMaybeSendPlaybookReview_ = originalBuild;
  }
});

test('runWeeklyTrainingCycle fires the right event for each day of the Fri/Sat/Mon cadence, and nothing on the other days', () => {
  const originalBuild = gas.buildAndMaybeSendPlaybookReview_;
  const originalLockService = gas.LockService;
  const originalUtilities = gas.Utilities;
  const originalReminder = gas.sendRepRecordingsReminder_;
  const originalLog = gas.log_;
  gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  gas.log_ = () => {};

  // Drive the handler's day/hour reads directly — this is what a real firing
  // sees, without needing a real clock.
  const runOn = (day, hour) => {
    const seen = { stages: [], reminders: 0 };
    gas.Utilities = { formatDate: (d, tz, fmt) => (fmt === 'EEE' ? day : String(hour)), sleep() {} };
    gas.buildAndMaybeSendPlaybookReview_ = (forcePreview, stage) => seen.stages.push({ forcePreview, stage });
    gas.sendRepRecordingsReminder_ = () => { seen.reminders++; return true; };
    gas.runWeeklyTrainingCycle();
    return seen;
  };

  try {
    const fri = runOn('Fri', gas.PLAYBOOK_REVIEW_CONFIG.RECORDINGS_REMINDER_HOUR);
    assert.equal(fri.reminders, 1, 'Friday sends the recordings reminder');
    assert.equal(fri.stages.length, 0, 'Friday must not build any playbook');

    const sat = runOn('Sat', gas.PLAYBOOK_REVIEW_CONFIG.DRAFT_TRIGGER_HOUR);
    assert.deepEqual(Array.from(sat.stages), [{ forcePreview: false, stage: 'draft' }], 'Saturday builds the Kris-only draft');
    assert.equal(sat.reminders, 0);

    const mon = runOn('Mon', gas.PLAYBOOK_REVIEW_CONFIG.REVIEW_TRIGGER_HOUR);
    assert.deepEqual(Array.from(mon.stages), [{ forcePreview: false, stage: 'final' }], 'Monday sends the reviewed playbooks');

    // Tuesday is when the humans run the sessions — the bot has nothing to do.
    const tue = runOn('Tue', 12);
    assert.equal(tue.stages.length, 0);
    assert.equal(tue.reminders, 0);

    // Before the configured hour on the right day, it must also stay quiet —
    // the daily trigger fires at the EARLIEST hour of the three, so Monday's
    // firing happens hours before Monday's own event is due.
    const monEarly = runOn('Mon', gas.PLAYBOOK_REVIEW_CONFIG.REVIEW_TRIGGER_HOUR - 1);
    assert.equal(monEarly.stages.length, 0, 'must not send Monday\'s email early just because the trigger fired');
  } finally {
    gas.buildAndMaybeSendPlaybookReview_ = originalBuild;
    gas.LockService = originalLockService;
    gas.Utilities = originalUtilities;
    gas.sendRepRecordingsReminder_ = originalReminder;
    gas.log_ = originalLog;
  }
});

test('installPlaybookReviewTrigger installs ONE daily trigger and clears every handler the schedule has ever used', () => {
  const originalScriptApp = gas.ScriptApp;
  // Every historical handler present at once, plus an unrelated one.
  gas.ScriptApp = fakeScriptAppTriggers_([
    'runWeeklyPlaybookReview', 'runWeeklyPlaybookReviewReminder', 'runWeeklyPlaybookReviewFinal',
    'runWeeklyTrainingCycle', 'someOtherTrigger'
  ]);
  try {
    gas.installPlaybookReviewTrigger();
    const handlers = gas.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    assert.ok(handlers.indexOf('someOtherTrigger') !== -1, 'unrelated trigger must be left alone');
    assert.equal(handlers.filter((h) => h === 'runWeeklyTrainingCycle').length, 1, 'exactly one cycle trigger, old copy removed');
    ['runWeeklyPlaybookReview', 'runWeeklyPlaybookReviewReminder', 'runWeeklyPlaybookReviewFinal'].forEach((old) => {
      assert.equal(handlers.indexOf(old), -1, old + ' must be deleted, not left as an orphan');
    });
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

test('the consolidated schedule NETS DOWN against the 20-trigger cap rather than adding a third weekly trigger (real bug, live 08/09/2026: the old installer hit "This script has too many triggers")', () => {
  const originalScriptApp = gas.ScriptApp;
  // The exact live shape that broke before: 18 unrelated + the old two-Monday
  // pair = 20, dead at the cap with a THIRD weekly event now required.
  const unrelated = [];
  for (let i = 0; i < 18; i++) unrelated.push('unrelatedTrigger' + i);
  gas.ScriptApp = fakeScriptAppTriggers_(unrelated.concat(['runWeeklyPlaybookReviewReminder', 'runWeeklyPlaybookReviewFinal']));
  const originalCreate = gas.ScriptApp.newTrigger;
  gas.ScriptApp.newTrigger = function (fnName) {
    if (gas.ScriptApp.getProjectTriggers().length >= 20) {
      throw new Error('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
    }
    return originalCreate(fnName);
  };
  try {
    gas.installPlaybookReviewTrigger();
    const handlers = gas.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    assert.equal(handlers.length, 19, '18 unrelated + one consolidated cycle trigger — a slot FREED, not consumed');
    assert.equal(handlers.filter((h) => h === 'runWeeklyTrainingCycle').length, 1);
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

test('STANDING_AUTOMATION_HANDLERS_ lists the consolidated cycle handler, and NOT the manual-only ones (which must be swept if a trigger still points at them)', () => {
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runWeeklyTrainingCycle') !== -1);
  ['runWeeklyPlaybookReview', 'runWeeklyPlaybookReviewReminder', 'runWeeklyPlaybookReviewFinal',
    'runWeeklyPlaybookReviewDraft'].forEach((manual) => {
    assert.equal(gas.STANDING_AUTOMATION_HANDLERS_.indexOf(manual), -1,
      manual + ' must not be a standing handler — the sweep has to clear any leftover trigger for it');
  });
});

test('stripYearFromDateRangeLabel_ strips every /yyyy year suffix out of a date-range label', () => {
  assert.equal(gas.stripYearFromDateRangeLabel_('24/08/2026 - 30/08/2026'), '24/08 - 30/08');
  assert.equal(gas.stripYearFromDateRangeLabel_('01/09/2026'), '01/09');
  assert.equal(gas.stripYearFromDateRangeLabel_('no dates here'), 'no dates here');
});

test('matchEventsForRep_ tags a miss as recordingMissing only when NO row at all exists for it (not even unlogged) — a row only ever exists once a transcript has been scored, so this is the "recording never arrived" signal Kris asked for (03/09/2026, Sean)', () => {
  const events = [
    { id: 'evt-has-unlogged-row', title: 'QC / Has Row', prospectGuess: 'Has Row', attendeeEmails: [], start: new Date('2026-09-01T14:00:00Z') },
    { id: 'evt-no-row-anywhere', title: 'Qualification Call / No Row', prospectGuess: 'No Row', attendeeEmails: [], start: new Date('2026-09-01T15:00:00Z') }
  ];
  const allRows = [
    { rowIndex: 5, sheet: null, eventIdCol: -1, matchMethodCol: -1, logged: false, prospect: 'has row', email: '', eventId: '', callType: 'QC' }
  ];
  const missing = gas.matchEventsForRep_('Sean', events, allRows, [], /*writeBack=*/false);

  assert.equal(missing.length, 2);
  const hasRowMiss = missing.filter((e) => e.id === 'evt-has-unlogged-row')[0];
  const noRowMiss = missing.filter((e) => e.id === 'evt-no-row-anywhere')[0];
  assert.equal(hasRowMiss.recordingMissing, false, 'an unlogged row still exists — this is "forgot to log the outcome," not a missing recording');
  assert.equal(noRowMiss.recordingMissing, true, 'no row anywhere for this event — the recording itself never arrived');
});

test('buildComplianceEmail_ lists every outstanding item oldest-first, each with its own date/age, and the subject names the oldest', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const repCfg = { name: 'Joana', email: 'joana@iconsofrealestate.com', spreadsheetId: 'SHEET_ID' };
  const backlog = [
    { eventId: 'evt-2', title: 'QC / Joseph Bradley', prospectGuess: 'Joseph Bradley', callDateLabel: '25/08/2026', time: '10:00', firstFlaggedAt: '2026-08-25T22:00:00.000Z' },
    { eventId: 'evt-1', title: 'QC / Nicole Freed', prospectGuess: 'Nicole Freed', callDateLabel: '20/08/2026', time: '09:00', firstFlaggedAt: '2026-08-20T22:00:00.000Z' }
  ];
  const email = gas.buildComplianceEmail_(repCfg, backlog, gas.CONFIG.BUSINESS_TIMEZONE);

  assert.ok(email.subject.indexOf('Nicole Freed') !== -1, 'subject should lead with the OLDEST outstanding item, not insertion order');
  assert.ok(email.subject.indexOf('20/08/2026') !== -1, 'subject should name the oldest item\'s original date');
  const nicoleIdx = email.body.indexOf('Nicole Freed');
  const josephIdx = email.body.indexOf('Joseph Bradley');
  assert.ok(nicoleIdx !== -1 && josephIdx !== -1 && nicoleIdx < josephIdx, 'body should list oldest-first');
  assert.ok(email.body.indexOf('20/08/2026') !== -1 && email.body.indexOf('25/08/2026') !== -1,
    'body should show each item\'s own original date, not just today\'s');
  assert.ok(email.body.indexOf('does not reset') !== -1, 'body should say this list carries forward, not a one-day snapshot');
});

test('buildComplianceEmail_ splits recording-missing items into their own section with different wording — "add the outcome" makes no sense for a call that was never transcribed (Kris\'s ask 03/09/2026, Sean)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const repCfg = { name: 'Sean', email: 'sean@iconsofrealestate.com', spreadsheetId: 'SHEET_ID' };
  const backlog = [
    { eventId: 'evt-unlogged', title: 'QC / Nicole Freed', prospectGuess: 'Nicole Freed', callDateLabel: '20/08/2026', time: '09:00', firstFlaggedAt: '2026-08-20T22:00:00.000Z', recordingMissing: false },
    { eventId: 'evt-no-recording', title: 'Qualification Call / Sabiha Razzak', prospectGuess: 'Sabiha Razzak', callDateLabel: '25/08/2026', time: '10:00', firstFlaggedAt: '2026-08-25T22:00:00.000Z', recordingMissing: true }
  ];
  const email = gas.buildComplianceEmail_(repCfg, backlog, gas.CONFIG.BUSINESS_TIMEZONE);

  assert.ok(email.body.indexOf('NO recording received at all') !== -1, 'recording-missing items must get their own distinct wording');
  assert.ok(email.body.indexOf('Sabiha Razzak') !== -1 && email.body.indexOf('Nicole Freed') !== -1, 'both items still listed');
  const noRecordingSectionIdx = email.body.indexOf('NO recording received at all');
  const sabihaIdx = email.body.indexOf('Sabiha Razzak');
  const nicoleIdx = email.body.indexOf('Nicole Freed');
  assert.ok(nicoleIdx < noRecordingSectionIdx, 'the plain unlogged item must not be pulled into the recording-missing section');
  assert.ok(sabihaIdx > noRecordingSectionIdx, 'the recording-missing item must appear inside its own section');
});

test('buildComplianceEmail_ deep-links the tracker to the right TAB via #gid= when given one, not a bare spreadsheet link (real bug: Joana\'s compliance email opened Bens\' tracker tab because every rep\'s spreadsheetId points at the same shared multi-tab workbook and a bare /edit URL opens whatever tab was last active)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const repCfg = { name: 'Joana', email: 'joana@iconsofrealestate.com', spreadsheetId: 'SHEET_ID' };
  const backlog = [
    { eventId: 'evt-1', title: 'QC / Nicole Freed', prospectGuess: 'Nicole Freed', callDateLabel: '20/08/2026', time: '09:00', firstFlaggedAt: '2026-08-20T22:00:00.000Z' }
  ];

  const withGid = gas.buildComplianceEmail_(repCfg, backlog, gas.CONFIG.BUSINESS_TIMEZONE, 987654321);
  assert.ok(withGid.body.indexOf('https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=987654321') !== -1,
    'the tracker link must carry the real tab\'s gid, not just the bare spreadsheet URL');

  // sheetGid omitted (e.g. resolveRepTrackerGid_ itself failed) must degrade
  // to the old bare link rather than breaking the email.
  const withoutGid = gas.buildComplianceEmail_(repCfg, backlog, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.ok(withoutGid.body.indexOf('https://docs.google.com/spreadsheets/d/SHEET_ID/edit\n') !== -1,
    'no gid given must fall back to a bare spreadsheet link, not throw or print "undefined"');
});

test('resolveRepTrackerGid_ resolves the REAL sheetId for repCfg.sheetName, not just the spreadsheet\'s default/first tab', () => {
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  try {
    const fakeSheet = { getSheetId: () => 555222111 };
    const fakeSs = {
      getSheetByName: (name) => (name === 'Sales Call Log' ? fakeSheet : null),
      getSheets: () => [{ getSheetId: () => -1 }] // a wrong-tab fallback that must NOT be what gets returned
    };
    gas.SpreadsheetApp = { openById: (id) => { assert.equal(id, 'SHEET_ID'); return fakeSs; } };
    const gid = gas.resolveRepTrackerGid_({ spreadsheetId: 'SHEET_ID', sheetName: 'Sales Call Log' });
    assert.equal(gid, 555222111);
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

// ---------------------------------------------------------------------------
// Training call review: flat-file transcript matching (26/08/2026 incident).
// Tomás started dropping the FULL Zoom bundle (video + .vtt) flat into a
// rep's root folder instead of the documented dated subfolder. Both files
// share the same date-prefixed naming, so the old "any date-prefixed file"
// matcher could pick up the .mp4 as if it were the transcript — for Sean
// this silently ate his entire training review for the week (no doc, no
// email, no visible error). These pin the fix: real transcripts still
// match by their own name (however they're named), but a Zoom recording
// extension never does, regardless of what else sits next to it.
// ---------------------------------------------------------------------------

test('looksLikeTranscriptFile_ matches real transcript naming, not just files that happen to sit near one', () => {
  assert.equal(gas.looksLikeTranscriptFile_('GMT20260825-090022_Recording.transcript.vtt'), true);
  assert.equal(gas.looksLikeTranscriptFile_('260819 Transcript'), true);
  assert.equal(gas.looksLikeTranscriptFile_('260819'), false); // bare date, no extension/marker — findFlatTrainingTranscripts_ allows this via the bare-Google-Doc fallback, not this predicate
  assert.equal(gas.looksLikeTranscriptFile_('260825_Recording_1920x1020.mp4'), false);
});

/** Minimal DriveApp Folder fake — just enough of the getFiles()/getName()/getMimeType() surface findFlatTrainingTranscripts_ actually calls. */
function fakeFolder(fileSpecs) {
  // Each entry is either a bare name string, or {name, mimeType} for the
  // bare-Google-Doc allowlist case. Fixed per-file, not a shared cursor —
  // findFlatTrainingTranscripts_ stashes the file object and reads its name
  // again later via .file.getName().
  const files = fileSpecs.map((spec) => {
    const { name, mimeType } = typeof spec === 'string' ? { name: spec, mimeType: null } : spec;
    return { getName: () => name, getMimeType: () => mimeType };
  });
  return {
    getFiles: () => {
      let i = 0;
      return {
        hasNext: () => i < files.length,
        next: () => files[i++]
      };
    }
  };
}

test('isValidTrainingReviewSchema_ accepts a clean call with zero objections drilled (real bug H-01: length > 0 contradicted the system prompt\'s own "including none" instruction)', () => {
  const base = {
    attended: true,
    practiced_objections: false,
    practiced_close_ask: true,
    practiced_framework: true, practiced_discovery: true,
    coaching_notes: 'Solid call, no objections came up.',
    next_focus: 'Keep it up.',
    team_notes: '',
    objections_to_drill: [],
    close_ask_drill: { label: 'Ask for the appointment', note: 'Nailed it.' },
    framework_gaps_to_drill: [],
    discovery_habits_to_drill: [],
    tomas_coaching: {
      grounded_in_real_data: true,
      gave_concrete_next_focus: true,
      coaching_feedback_summary: 'Grounded in a real objection from this call.',
      facilitation_action_for_next_time: 'Keep doing this.'
    }
  };
  assert.equal(gas.isValidTrainingReviewSchema_(base), true);

  const malformed = Object.assign({}, base, { objections_to_drill: [{ label: 'ok' }] });
  assert.equal(gas.isValidTrainingReviewSchema_(malformed), false,
    'a malformed (non-string note) entry should still fail validation');
});

test('findFlatTrainingTranscripts_ finds a real transcript named the way Zoom actually names it (real bug: "_" broke the old \\b boundary check)', () => {
  // Sean's actual filenames from the live incident: the .vtt uses Zoom's
  // default "YYMMDD_Recording..." naming (underscore right after the
  // date), which the old `/^(\d{6})\b/` regex silently failed to match —
  // it never even showed up in the run's log. Bens'/Joana's equivalents
  // used "-" and " " respectively right after the date, which is the only
  // reason those worked while Sean's didn't.
  const folder = fakeFolder([
    '260825_Recording.transcript.vtt',   // Sean's real transcript — must be found
    '260825_Recording_1920x1020.mp4',    // its video sibling — must be excluded
    '260819 Training Plan'               // a previous run's output — must be excluded
  ]);
  const found = gas.findFlatTrainingTranscripts_(folder);
  assert.equal(found.length, 1, 'exactly the one real transcript should be found');
  assert.equal(found[0].file.getName(), '260825_Recording.transcript.vtt');
  assert.equal(found[0].dateLabel, '260825');
});

test('findFlatTrainingTranscripts_ allowlists real transcripts (incl. a bare Google Doc) instead of just denylisting known video extensions (real bug H-02: a stray date-prefixed PDF/screenshot could still be treated as the transcript)', () => {
  const folder = fakeFolder([
    '260819 Transcript',                                              // named transcript — allowed
    { name: '260819', mimeType: 'application/vnd.google-apps.document' }, // bare Google Doc, no video alongside — allowed
    '260819 notes.pdf',                                               // a stray date-prefixed PDF of notes — must be REJECTED, not silently fed to the judge
    '260819_screenshot.png'                                           // a stray screenshot — must be REJECTED too
  ]);
  const found = gas.findFlatTrainingTranscripts_(folder);
  // Array.from (not found.map) because `found` is an Array built inside the
  // vm sandbox's own realm — .map() on it would return another foreign-realm
  // array via species construction, which fails deepStrictEqual against a
  // plain literal array purely on prototype identity, not actual content.
  const names = Array.from(found, (f) => f.file.getName());
  assert.deepEqual(names.sort(), ['260819', '260819 Transcript']);
});

// ---------------------------------------------------------------------------
// Training call review: role-aware skills (26/08/2026, per Kris). Bens only
// runs ICONS 100 lead-gen interviews and QCs -- he never asks for money
// (Phase2_CallScoring.gs's buildBensJudgeSystemPrompt_ already reflects this,
// added 22/08/2026) and never explains the framework himself; his equivalent
// of "the close" is asking to book the next concrete step. The training-call
// review never got that same distinction, so his own training-plan email was
// showing a misleading red "Asking for the money practiced: No" and
// "Framework explanation practiced: No" for skills that were never his job.
// ---------------------------------------------------------------------------

test('buildTrainingReviewSystemPrompt_ grades Bens on asking for the appointment, not money, and drops framework explanation entirely', () => {
  const bensPrompt = gas.buildTrainingReviewSystemPrompt_('Bens');
  assert.ok(/asking for the appointment/i.test(bensPrompt), 'should describe his close-equivalent as booking the appointment');
  assert.ok(!/asking for the money/i.test(bensPrompt), 'should not grade him on a money-ask that was never his job');
  assert.equal(bensPrompt.indexOf('FRAMEWORK EXPLANATION = proactively'), -1, 'should not define/ask about framework explanation for him at all');
  assert.ok(/practiced_framework.*false/i.test(bensPrompt) || bensPrompt.indexOf('always return') !== -1,
    'should explicitly instruct the model to report no framework practice rather than silently omitting the field');
});

test('buildTrainingReviewSystemPrompt_ leaves Sean/Joana on the shared money-ask + framework rubric unchanged', () => {
  const seanPrompt = gas.buildTrainingReviewSystemPrompt_('Sean');
  assert.ok(/asking for the money/i.test(seanPrompt));
  assert.ok(/FRAMEWORK EXPLANATION = proactively/.test(seanPrompt));
  const joanaPrompt = gas.buildTrainingReviewSystemPrompt_('Joana');
  assert.ok(/asking for the money/i.test(joanaPrompt));
  assert.ok(/FRAMEWORK EXPLANATION = proactively/.test(joanaPrompt));
});

test('buildTrainingReviewEmail_ never shows a framework badge/section for Bens, and relabels the close-ask skill', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    attended: true, practiced_objections: true, practiced_close_ask: false, practiced_framework: false, practiced_discovery: true,
    coaching_notes: 'Notes here', next_focus: 'focus', objections_to_drill: [{ label: 'Too busy', note: 'agree/isolate/repeat' }],
    close_ask_drill: null, framework_gaps_to_drill: [{ topic: 'recruit_agents', note: 'say this' }], team_notes: 'none'
  };
  const email = gas.buildTrainingReviewEmail_('Bens', '260825', result);
  assert.ok(email.body.indexOf('Practiced asking for the appointment') !== -1);
  assert.equal(email.body.indexOf('the money'), -1, 'must not mention money anywhere for Bens');
  assert.equal(email.body.indexOf('Framework explanation'), -1,
    'must not show a framework line at all, even if the model returned framework_gaps_to_drill by mistake');
  assert.equal(email.htmlBody.indexOf('Framework explanation practiced'), -1);
});

test('buildTrainingReviewEmail_ still shows the framework badge/section for Sean/Joana as before', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    attended: true, practiced_objections: true, practiced_close_ask: true, practiced_framework: false, practiced_discovery: true,
    coaching_notes: 'Notes here', next_focus: 'focus', objections_to_drill: [{ label: 'Budget', note: 'agree/isolate/repeat' }],
    close_ask_drill: { label: 'Ready to get started?', note: 'ask again on objection' },
    framework_gaps_to_drill: [{ topic: 'sell_more_houses', note: 'say this' }], team_notes: 'none'
  };
  const email = gas.buildTrainingReviewEmail_('Sean', '260825', result);
  assert.ok(email.body.indexOf('Practiced asking for the money') !== -1);
  assert.ok(email.body.indexOf('Framework explanation to drill') !== -1);
  assert.ok(email.htmlBody.indexOf('Framework explanation practiced') !== -1);
});

test('trainingCallPlanWeekLabel_ reads the WEEK the training call\'s Tuesday feeds (the following week\'s cycle), not the week the call itself falls in (per Kris, 28/08/2026: so the weekly plan email carries the same number as that week\'s daily practice assignments)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // 260825 = Tue 25 Aug 2026, the training call that kicks off Week 2
  // (Wed 26 Aug is Week 2 Day 1 — see the epoch test below).
  assert.equal(gas.trainingCallPlanWeekLabel_('260825', tz), 'Week 2');
});

test('trainingCallPlanWeekLabel_ returns null for a dateLabel that doesn\'t parse as YYMMDD, so the caller falls back to the raw label instead of throwing', () => {
  assert.equal(gas.trainingCallPlanWeekLabel_('not-a-date', 'America/New_York'), null);
  assert.equal(gas.trainingCallPlanWeekLabel_('', 'America/New_York'), null);
});

test('buildTrainingReviewEmail_ subject carries the week number, not the raw call date', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    attended: true, practiced_objections: true, practiced_close_ask: false, practiced_framework: false, practiced_discovery: true,
    coaching_notes: 'Notes here', next_focus: 'focus', objections_to_drill: [{ label: 'Too busy', note: 'agree/isolate/repeat' }],
    close_ask_drill: null, framework_gaps_to_drill: [], discovery_habits_to_drill: [], team_notes: 'none'
  };
  const email = gas.buildTrainingReviewEmail_('Sean', '260825', result);
  assert.equal(email.subject, 'Training Call Plan — Sean — Week 2');
});

// ---------------------------------------------------------------------------
// Tomás's own coaching feedback (02/09/2026, per Kris: "shouldn't he receive
// feedback on his training") — a separate email judged on facilitation
// quality, not the rep's performance.
// ---------------------------------------------------------------------------

test('isValidTrainingReviewSchema_ rejects a result missing/malformed tomas_coaching', () => {
  const base = {
    attended: true, practiced_objections: false, practiced_close_ask: true, practiced_framework: true, practiced_discovery: true,
    coaching_notes: 'Solid call.', next_focus: 'Keep it up.', team_notes: '',
    objections_to_drill: [], close_ask_drill: { label: 'Ask for the appointment', note: 'Nailed it.' },
    framework_gaps_to_drill: [], discovery_habits_to_drill: [],
    tomas_coaching: {
      grounded_in_real_data: true,
      gave_concrete_next_focus: true,
      coaching_feedback_summary: 'Grounded the session in a real objection from this week.',
      facilitation_action_for_next_time: 'Keep grounding sessions in the rep\'s real pipeline.'
    }
  };
  assert.equal(gas.isValidTrainingReviewSchema_(base), true);

  const missing = Object.assign({}, base);
  delete missing.tomas_coaching;
  assert.equal(gas.isValidTrainingReviewSchema_(missing), false, 'missing tomas_coaching must fail validation');

  const malformed = Object.assign({}, base, {
    tomas_coaching: { grounded_in_real_data: 'yes', gave_concrete_next_focus: true, coaching_feedback_summary: 'ok', facilitation_action_for_next_time: 'ok' }
  });
  assert.equal(gas.isValidTrainingReviewSchema_(malformed), false, 'non-boolean grounded_in_real_data must fail validation');

  // Real gap this schema addition closes 10/09/2026 (Kris: "How are they
  // meant to action it?") — a judge that returns everything else but drops
  // the one field that actually tells Tomás what to do differently must not
  // be treated as a valid, complete review.
  const missingAction = Object.assign({}, base, {
    tomas_coaching: { grounded_in_real_data: true, gave_concrete_next_focus: true, coaching_feedback_summary: 'ok' }
  });
  assert.equal(gas.isValidTrainingReviewSchema_(missingAction), false,
    'missing facilitation_action_for_next_time must fail validation, same as the other tomas_coaching fields');
});

test('reviewTrainingCallTranscript_\'s parse-failure fallback carries a tomas_coaching stub, so buildTomasCoachingFeedbackEmail_ never sees an undefined field', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const originalConfig = gas.PHASE2_CONFIG;
  const originalCallKimiJudge = gas.callKimiJudge_;
  try {
    gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 0 };
    gas.callKimiJudge_ = () => 'not json';
    const result = gas.reviewTrainingCallTranscript_('Sean', 'transcript text', '260825');
    assert.ok(result.tomas_coaching, 'fallback must include a tomas_coaching object');
    assert.equal(result.tomas_coaching.grounded_in_real_data, false);
    assert.equal(result.tomas_coaching.gave_concrete_next_focus, false);
    assert.equal(typeof result.tomas_coaching.coaching_feedback_summary, 'string');
    assert.equal(typeof result.tomas_coaching.facilitation_action_for_next_time, 'string');
  } finally {
    gas.PHASE2_CONFIG = originalConfig;
    gas.callKimiJudge_ = originalCallKimiJudge;
  }
});

test('reviewTrainingCallTranscript_\'s parse-failure fallback carries manual_review_recommended: true, so callers can tell it apart from a real score', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const originalConfig = gas.PHASE2_CONFIG;
  const originalCallKimiJudge = gas.callKimiJudge_;
  try {
    gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 0 };
    gas.callKimiJudge_ = () => 'not json';
    const result = gas.reviewTrainingCallTranscript_('Sean', 'transcript text', '260825');
    assert.equal(result.manual_review_recommended, true);
  } finally {
    gas.PHASE2_CONFIG = originalConfig;
    gas.callKimiJudge_ = originalCallKimiJudge;
  }
});

test('buildTomasCoachingFeedbackEmail_ shows a "review unavailable" notice instead of misleading red badges when the judge never actually scored the call (real bug 02/09/2026, Tomás: parse failure rendered as "Grounded in real calls: No" / "Concrete next focus set: No", reading as genuine negative feedback on his facilitation)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    manual_review_recommended: true,
    tomas_coaching: { grounded_in_real_data: false, gave_concrete_next_focus: false, coaching_feedback_summary: 'Unscored — parse failure after retries.' }
  };
  const email = gas.buildTomasCoachingFeedbackEmail_('Joana', '260901', result);
  assert.ok(email.body.indexOf('Grounded in') === -1, 'must not render the misleading Yes/No badge line at all');
  assert.ok(email.htmlBody.indexOf('Grounded in') === -1, 'must not render the misleading Yes/No badge in HTML either');
  assert.ok(email.body.toLowerCase().indexOf('review unavailable') !== -1 || email.body.toLowerCase().indexOf("couldn't parse") !== -1,
    'must clearly say the review failed');
  assert.ok(email.body.toLowerCase().indexOf('not') !== -1 && email.body.toLowerCase().indexOf('feedback') !== -1,
    'must explicitly say this is not real feedback');
});

test('buildTrainingReviewEmail_ shows a "review unavailable" notice instead of a misleading "Attended: No" badge when the judge never actually scored the call', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = { manual_review_recommended: true, attended: true, coaching_notes: 'Automated review failed to parse twice — read the transcript manually.' };
  const email = gas.buildTrainingReviewEmail_('Sean', '260901', result);
  assert.ok(email.body.indexOf('Attended:') === -1, 'must not render the misleading Attended badge line at all');
  assert.ok(email.htmlBody.indexOf('Attended:') === -1, 'must not render the misleading Attended badge in HTML either');
  assert.ok(email.body.toLowerCase().indexOf("couldn't parse") !== -1 || email.body.toLowerCase().indexOf('review unavailable') !== -1,
    'must clearly say the review failed');
});

test('trainingReviewFormatText_ escapes, then turns \\n into <br>, then italicizes quoted substrings — same transform buildDailyPracticeFeedbackEmail_ already uses (Kris 03/09/2026: "BLOCKS of text are too long without whitespace, bolding, italic" on the Notes callout, which never got the 31/08 Daily Practice fix applied to it)', () => {
  const out = gas.trainingReviewFormatText_('Sean said "that\'s not an objection" here.\nThen a second point.\n<b>ignored</b>');
  assert.ok(out.indexOf('<br>') !== -1, 'newlines must become <br>');
  assert.ok(out.indexOf('<i>&quot;that&#39;s not an objection&quot;</i>') !== -1 || out.indexOf('<i>&quot;that') !== -1,
    'a quoted moment must be italicized');
  assert.ok(out.indexOf('<b>ignored</b>') === -1, 'raw HTML in the AI text must be escaped, not rendered');
});

test('buildTrainingReviewEmail_ formats coaching_notes and team_notes with line breaks and italicized quotes in the HTML body, not as one raw dense block (real bug 03/09/2026: these two callouts never got the 31/08 Daily Practice / 02/09 Playbook Review formatting fix applied)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    attended: true, practiced_objections: true, practiced_close_ask: true, practiced_framework: true, practiced_discovery: true,
    coaching_notes: 'First point about the budget role-play.\nSecond point: Sean said "I\'ll fight the machine" here.',
    next_focus: 'focus', objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [],
    discovery_habits_to_drill: [],
    team_notes: 'Applies to everyone: "seek the cause" before restating value.\nAlso: don\'t pitch launchpad-only first.'
  };
  const email = gas.buildTrainingReviewEmail_('Sean', '260825', result);
  assert.ok(email.htmlBody.indexOf('First point about the budget role-play.<br>Second point') !== -1,
    'coaching_notes newlines must render as <br>, not run together as one paragraph');
  assert.ok(email.htmlBody.indexOf('<i>&quot;I') !== -1, 'a quoted line in coaching_notes must be italicized');
  assert.ok(email.htmlBody.indexOf('Applies to everyone:') !== -1 && email.htmlBody.indexOf('<br>Also:') !== -1,
    'team_notes must get the same line-break treatment as coaching_notes');
});

test('buildTrainingReviewEmail_ states up front that this plan belongs to the rep, and renders discovery_habits_to_drill as its own section instead of silently dropping it (real gap 10/09/2026, Kris, reading a discovery-focused call: "Focus this week is meant to be discovery. How to practice discovery?")', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    attended: true, practiced_objections: false, practiced_close_ask: false, practiced_framework: false, practiced_discovery: false,
    coaching_notes: 'Main correction: pre-call discovery is too thin.',
    next_focus: 'focus', objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [],
    discovery_habits_to_drill: [
      { label: 'ask for a number on the goal', note: 'not "wants to grow", get a specific target and date' },
      { label: 'confirm prior info before asking new questions', note: 'note down what you already know and open with it' }
    ],
    team_notes: 'none'
  };
  const email = gas.buildTrainingReviewEmail_('Joana', '260908', result);
  assert.ok(email.body.indexOf('This is YOUR plan') !== -1,
    'the plain-text body must state up front that this plan belongs to the rep');
  assert.ok(email.htmlBody.indexOf('This is YOUR plan') !== -1,
    'the HTML body must carry the same framing line');
  assert.ok(email.body.indexOf('Discovery habits to drill:') !== -1 &&
    email.body.indexOf('ask for a number on the goal') !== -1,
    'discovery habits must actually appear in the plain-text body, not just get persisted for Phase 7');
  assert.ok(email.htmlBody.indexOf('Discovery to drill') !== -1 &&
    email.htmlBody.indexOf('confirm prior info before asking new questions') !== -1,
    'discovery habits must get their own labeled HTML section, same treatment as objections/close-ask/framework');
});

test('buildTomasCoachingFeedbackEmail_ formats coaching_feedback_summary with line breaks and italicized quotes in the HTML body', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    practiced_objections: true, practiced_close_ask: true, practiced_framework: true, practiced_discovery: true,
    tomas_coaching: {
      grounded_in_real_data: true, gave_concrete_next_focus: true,
      coaching_feedback_summary: 'Grounded the session in Sean\'s real calls.\nClosed with "practice this exact line" — concrete.'
    }
  };
  const email = gas.buildTomasCoachingFeedbackEmail_('Sean', '260825', result);
  assert.ok(email.htmlBody.indexOf('Grounded the session in Sean\'s real calls.<br>Closed with') !== -1,
    'coaching_feedback_summary newlines must render as <br>');
  assert.ok(email.htmlBody.indexOf('<i>&quot;practice this exact line&quot;</i>') !== -1,
    'a quoted line must be italicized');
});

test('buildTrainingReviewSystemPrompt_ drills DISCOVERY for every rep, with Tomás\'s goal-vs-pain definition and the ICONS 100 depth caveat', () => {
  // Real gap found 09/09/2026: Bens' training call was almost entirely about
  // discovery, and Phase 6 graded only objections/close-ask/framework — so a
  // call full of coaching would have come back reporting nothing practiced.
  ['Bens', 'Sean'].forEach((rep) => {
    const prompt = gas.buildTrainingReviewSystemPrompt_(rep);
    assert.ok(prompt.indexOf('DISCOVERY =') !== -1, rep + ': discovery must be a named, defined skill');
    assert.ok(/practiced_discovery/.test(prompt), rep + ': the judge must return practiced_discovery');
    assert.ok(/discovery_habits_to_drill/.test(prompt), rep + ': the drill must be extractable for daily practice');
    // Tomás's correction: a goal is a business metric, not "connect with agents".
    assert.ok(prompt.indexOf('not a goal') !== -1, rep + ': the vague-goal exclusion must survive into the prompt');
    // ...and pain is not the numeric shortfall.
    assert.ok(/running FROM/.test(prompt), rep + ': pain must be defined as what they run FROM');
    assert.ok(prompt.indexOf("what's your bottleneck?") !== -1,
      rep + ': the prompt must say asking for the bottleneck directly does not count');
  });
});

test('buildTrainingReviewSystemPrompt_\'s tomas_coaching instruction explicitly requires naming discovery when the call covered it, not folding it into a generic "grounded in real data" line (real gap 10/09/2026, Kris: "he is also training discovery" — invisible in the facilitation summary)', () => {
  const prompt = gas.buildTrainingReviewSystemPrompt_('Sean');
  assert.ok(prompt.indexOf('Name EVERY skill this call actually touched') !== -1,
    'the coaching_feedback_summary instruction must require naming every skill covered, not just grounding/next-focus');
  assert.ok(/discovery.*must say so explicitly/is.test(prompt) || prompt.indexOf('must say so explicitly') !== -1,
    'the prompt must explicitly forbid silently folding a discovery-heavy call into the generic grounding line');
});

test('buildTrainingReviewSystemPrompt_ keeps discovery depth scoped to the call type — Tomás: "only supposed to open up a little bit of the door"', () => {
  const prompt = gas.buildTrainingReviewSystemPrompt_('Bens');
  assert.ok(prompt.indexOf('30-minute discovery') !== -1,
    'the prompt must carry the explicit warning against coaching a full discovery inside a podcast recording');
  assert.ok(prompt.indexOf('ICONS 100') !== -1, 'the light-touch caveat must name the call type it applies to');
});

test('isValidTrainingReviewSchema_ now requires practiced_discovery, so a judge that silently drops it falls back to manual review', () => {
  const base = {
    attended: true, practiced_objections: true, practiced_close_ask: true, practiced_framework: true,
    practiced_discovery: true,
    coaching_notes: 'x', next_focus: 'y', team_notes: 'none',
    objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [], discovery_habits_to_drill: [],
    tomas_coaching: { grounded_in_real_data: true, gave_concrete_next_focus: true, coaching_feedback_summary: 'z', facilitation_action_for_next_time: 'z' }
  };
  assert.equal(gas.isValidTrainingReviewSchema_(base), true);
  const missing = Object.assign({}, base);
  delete missing.practiced_discovery;
  assert.equal(gas.isValidTrainingReviewSchema_(missing), false,
    'a missing practiced_discovery must fail the schema rather than be read as false');
});

test('buildTomasCoachingFeedbackEmail_ derives rep_got_to_practice from the judge\'s own practiced_* fields rather than asking a second question, and skips framework for Bens', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const coaching = { grounded_in_real_data: true, gave_concrete_next_focus: false, coaching_feedback_summary: 'Leaned on generic advice instead of Bens\' real calls.' };

  // Bens: no objection/close/discovery practice this call, but framework doesn't count for him anyway.
  const bensResult = {
    practiced_objections: false, practiced_close_ask: false, practiced_framework: true, practiced_discovery: false,
    tomas_coaching: coaching
  };
  const bensEmail = gas.buildTomasCoachingFeedbackEmail_('Bens', '260825', bensResult);
  assert.ok(bensEmail.body.indexOf('got to practice out loud: No') !== -1,
    'Bens practiced neither objections nor the close-ask, and framework never counts for him');

  // Discovery DOES count for Bens (added 09/09/2026) — it is the one skill of
  // the four that applies to every rep regardless of role.
  const bensDiscoveryOnly = {
    practiced_objections: false, practiced_close_ask: false, practiced_framework: false, practiced_discovery: true,
    tomas_coaching: coaching
  };
  assert.ok(gas.buildTomasCoachingFeedbackEmail_('Bens', '260825', bensDiscoveryOnly)
    .body.indexOf('got to practice out loud: Yes') !== -1,
    'a discovery-only training call must count as Bens having practiced something');

  // Sean: didn't practice objections/close, but DID drill framework — should count as having practiced.
  const seanResult = {
    practiced_objections: false, practiced_close_ask: false, practiced_framework: true, practiced_discovery: false,
    tomas_coaching: coaching
  };
  const seanEmail = gas.buildTomasCoachingFeedbackEmail_('Sean', '260825', seanResult);
  assert.ok(seanEmail.body.indexOf('got to practice out loud: Yes') !== -1,
    'Sean\'s framework drill should count toward practice since his role covers it');
});

test('buildTomasCoachingFeedbackEmail_ subject carries the week number, stays distinct from the rep\'s own Training Call Plan subject, and can\'t be misread as being about the rep (real confusion 10/09/2026, Kris: "It\'s not clear! The feedback is for Tomas or for Joana?")', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    practiced_objections: true, practiced_close_ask: true, practiced_framework: true, practiced_discovery: true,
    tomas_coaching: { grounded_in_real_data: true, gave_concrete_next_focus: true, coaching_feedback_summary: 'Good session.' }
  };
  const email = gas.buildTomasCoachingFeedbackEmail_('Sean', '260825', result);
  assert.equal(email.subject, 'Your Facilitation Feedback — training call with Sean — Week 2');
});

test('buildTomasCoachingFeedbackEmail_ states up front that this is feedback on the recipient\'s own facilitation, not the rep\'s performance, and surfaces a concrete next-time action separately from the feedback summary', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    practiced_objections: true, practiced_close_ask: true, practiced_framework: true, practiced_discovery: true,
    tomas_coaching: {
      grounded_in_real_data: true, gave_concrete_next_focus: true,
      coaching_feedback_summary: 'Grounded in Joana\'s real pipeline.',
      facilitation_action_for_next_time: 'Run a short role-play of the objection out loud before moving on.'
    }
  };
  const email = gas.buildTomasCoachingFeedbackEmail_('Joana', '260908', result);
  assert.ok(email.body.indexOf('not a review of Joana\'s own performance') !== -1,
    'the plain-text body must explicitly say this is about the recipient\'s facilitation, not the rep');
  assert.ok(email.htmlBody.indexOf('not a review of Joana') !== -1,
    'the HTML body must carry the same framing line');
  assert.ok(email.body.indexOf('Run a short role-play of the objection out loud before moving on.') !== -1,
    'the concrete next-time action must appear in the plain-text body');
  assert.ok(email.htmlBody.indexOf('What to do differently next time') !== -1,
    'the HTML body must have its own clearly labeled action callout, distinct from the feedback summary callout');
});

test('buildTomasCoachingFeedbackEmail_ breaks the combined "got to practice out loud" badge into a per-skill breakdown, so discovery is never silently folded into a single yes/no (real gap 10/09/2026, Kris, reading Sean\'s call: "he is also training discovery" — nowhere visible in the email despite being part of the session)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  // Discovery practiced, objections were not — the old combined badge would
  // still have read "got to practice out loud: Yes" with no way to tell
  // which skill that Yes actually covered.
  const result = {
    practiced_objections: false, practiced_close_ask: false, practiced_framework: false, practiced_discovery: true,
    tomas_coaching: {
      grounded_in_real_data: true, gave_concrete_next_focus: true,
      coaching_feedback_summary: 'Grounded in Sean\'s real calls, discovery gap addressed.',
      facilitation_action_for_next_time: 'Keep drilling discovery next session.'
    }
  };
  const email = gas.buildTomasCoachingFeedbackEmail_('Sean', '260908', result);
  assert.ok(email.body.indexOf('Discovery: Yes') !== -1,
    'plain-text body must show discovery practiced separately from the other skills');
  assert.ok(email.body.indexOf('Objection handling: No') !== -1,
    'plain-text body must show objection handling as a separate No, distinct from the overall combined badge');
  assert.ok(email.htmlBody.indexOf('Skills that got real practice reps this session') !== -1,
    'HTML body must have a labeled per-skill breakdown section');
  assert.ok(email.htmlBody.indexOf('Discovery practiced') !== -1,
    'HTML body must show a Discovery-specific badge, same label the rep\'s own plan email uses');
});

// ---------------------------------------------------------------------------
// Silent-failure audit fixes (26/08/2026) — one regression test per verified
// Critical/High finding that has a pure-logic surface to pin.
// ---------------------------------------------------------------------------

test('computeTrainingCycleLabel_ epoch is built in business time, not the script default timezone (real bug: every Tuesday reported next week\'s number)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const label = (isoNoon) => gas.computeTrainingCycleLabel_(new Date(isoNoon), tz).label;
  assert.equal(label('2026-08-19T16:00:00Z'), 'Week 1, Day 1');
  assert.equal(label('2026-08-25T16:00:00Z'), 'Week 1, Day 5', 'Tuesday must still read as Week 1');
  assert.equal(label('2026-08-26T16:00:00Z'), 'Week 2, Day 1', 'the rollover happens Wednesday, not Tuesday');
});

test('sendOpsAlert_ does not route through guardedSend_\'s config gate (real bug: a config problem silenced the alert reporting it)', () => {
  const calls = [];
  gas.MailApp = { sendEmail: (...args) => calls.push(args) };
  gas.CONFIG.OPS_ALERT_EMAIL = 'kris@iconsofrealestate.com';
  // auditConfig_ would return not-ok here (a rep email not in INTERNAL_EMAILS) --
  // guardedSend_ itself would refuse, but sendOpsAlert_ must not ask it.
  const okBefore = gas.auditConfig_().ok;
  const sent = gas.sendOpsAlert_('test subject', 'test body');
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'kris@iconsofrealestate.com');
  assert.ok(calls[0][1].indexOf('test subject') !== -1);
  assert.equal(okBefore, gas.auditConfig_().ok, 'sanity: auditConfig_ itself is unaffected by this test');
});

test('sendOpsAlert_ passes an optional htmlBody through to MailApp, and still works with none (30/08/2026, Kris: "Terribly formatted email. Who wants to read this?")', () => {
  const originalMailApp = gas.MailApp;
  const originalOpsEmail = gas.CONFIG.OPS_ALERT_EMAIL;
  try {
    const calls = [];
    gas.MailApp = { sendEmail: (...args) => calls.push(args) };
    gas.CONFIG.OPS_ALERT_EMAIL = 'kris@iconsofrealestate.com';

    // Compare fields directly, not via assert.deepEqual — the vm sandbox's
    // plain object literals come from its own realm, so a constructor-
    // identity check against this file's own {} would fail for realm
    // reasons, not a real mismatch (same convention used elsewhere in this
    // file for sandbox-returned arrays/objects).
    gas.sendOpsAlert_('plain subject', 'plain body');
    assert.deepEqual(Object.keys(calls[0][3]), [], 'no htmlBody arg must still send cleanly with an empty options object');

    gas.sendOpsAlert_('styled subject', 'styled body', '<p>styled</p>');
    assert.equal(calls[1][3].htmlBody, '<p>styled</p>');
  } finally {
    gas.MailApp = originalMailApp;
    gas.CONFIG.OPS_ALERT_EMAIL = originalOpsEmail;
  }
});

test('buildHeaderDriftAlertHtml_ renders the mismatch list as real HTML with bold/structure, not a wall of plain text', () => {
  const html = gas.buildHeaderDriftAlertHtml_(['column 27: expected "Flag: Delivery Effective", found ""', 'column 28: expected "Delivery Gaps", found ""']);
  assert.match(html, /<strong style="color:#c0392b;">Sales Call Log header drift<\/strong>/);
  assert.match(html, /<code[^>]*>column 27: expected "Flag: Delivery Effective", found ""<\/code>/);
  assert.match(html, /<strong>setupSalesCallLog\(\)<\/strong>/);
});

test('alertHeaderDriftOnce_ sends both a plain body and the styled htmlBody', () => {
  const originalMailApp = gas.MailApp;
  const originalOpsEmail = gas.CONFIG.OPS_ALERT_EMAIL;
  const originalProps = gas.PropertiesService;
  try {
    const calls = [];
    gas.MailApp = { sendEmail: (...args) => calls.push(args) };
    gas.CONFIG.OPS_ALERT_EMAIL = 'kris@iconsofrealestate.com';
    const store = {};
    gas.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) };

    gas.alertHeaderDriftOnce_(['column 27: expected "Flag: Delivery Effective", found ""']);

    assert.equal(calls.length, 1);
    assert.match(calls[0][2], /does not match what the code/, 'plain body must still be a real fallback');
    assert.match(calls[0][3].htmlBody, /<strong style="color:#c0392b;">Sales Call Log header drift<\/strong>/);
  } finally {
    gas.MailApp = originalMailApp;
    gas.CONFIG.OPS_ALERT_EMAIL = originalOpsEmail;
    gas.PropertiesService = originalProps;
  }
});

test('installAllReadyTriggers_ sweeps ANY trigger not in STANDING_AUTOMATION_HANDLERS_, not just one hardcoded ad-hoc handler (real bug, 03/09/2026: the old carve-out only ever knew about installRescoreAllCallsTrigger() by name — a second ad-hoc backfill added the same day, installRescoreLastWeekTrigger(), would have been just as invisible to it as the three phases below turned out to be)', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalInstallAutomation = gas.installAutomation;
  const originalInstallPhase2Trigger = gas.installPhase2Trigger;
  const originalInstallSean = gas.installSeanScoringAutomation;
  const originalInstallTomas = gas.installTomasScoringAutomation;
  const originalInstallJoana = gas.installJoanaScoringAutomation;
  const originalInstallBens = gas.installBensScoringAutomation;
  const configFlags = ['HANDOFF_CONFIG', 'INBOX_SLA_CONFIG', 'WEEKLY_SCORECARD_CONFIG', 'TRAINING_REVIEW_CONFIG',
    'TOMAS_TRANSCRIPT_REMINDER_CONFIG', 'DAILY_PRACTICE_CONFIG', 'RANDOM_CALIBRATION_CONFIG', 'REPLY_TRACKER_CONFIG',
    'PLAYBOOK_REVIEW_CONFIG', 'WEEKLY_TRAINING_SUMMARY_CONFIG', 'GHL_CONFIG'];
  const originalEnabled = {};
  try {
    // Seed two orphans a real project could accumulate: an old-style ad-hoc
    // backfill runner, and a totally unrecognized leftover (e.g. a trigger
    // someone added by hand in the Console UI, or a since-renamed handler).
    gas.ScriptApp = fakeScriptAppTriggers_(['runRescoreAllCallsViaTrigger_', 'someLongDeletedFunction_']);
    gas.installAutomation = () => {};
    gas.installPhase2Trigger = () => {};
    gas.installSeanScoringAutomation = () => {};
    gas.installTomasScoringAutomation = () => {};
    gas.installJoanaScoringAutomation = () => {};
    // Mimics a real install*() function's side effect: sets its own RUN_TAG.
    // Needed to actually exercise the RUN_TAG-restore bug below — without this,
    // RUN_TAG would already read 'installAllReadyTriggers_' by coincidence.
    gas.installBensScoringAutomation = () => { gas.RUN_TAG = 'installBensScoringAutomation'; };
    configFlags.forEach((name) => { originalEnabled[name] = gas[name].ENABLED; gas[name].ENABLED = false; });

    const originalLog = gas.Logger.log;
    const lines = [];
    gas.Logger.log = (msg) => lines.push(msg);
    try {
      gas.installAllReadyTriggers_();
    } finally {
      gas.Logger.log = originalLog;
    }

    const remainingHandlers = gas.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    assert.ok(remainingHandlers.indexOf('runRescoreAllCallsViaTrigger_') === -1,
      'the known ad-hoc rescore runner must still be swept');
    assert.ok(remainingHandlers.indexOf('someLongDeletedFunction_') === -1,
      'ANY unrecognized handler must be swept, not just the one the old carve-out knew by name');

    const doneLine = lines.find((l) => l.indexOf('installAllReadyTriggers_ done.') !== -1);
    assert.match(doneLine, /Swept 2 orphan trigger\(s\)/, 'the summary must report what the sweep removed');

    // Real bug found live (31/08/2026): every install*() call above sets its
    // own RUN_TAG, leaving it stuck on whichever ran last (here,
    // installBensScoringAutomation) by the time the "done" summary logs —
    // it showed up live as "[installReplyTrackerTriggers] installAllReadyTriggers_
    // done." instead of its own tag.
    assert.match(doneLine, /^\[installAllReadyTriggers_\] installAllReadyTriggers_ done\./,
      'the final summary log must carry installAllReadyTriggers_\'s own RUN_TAG, not a stale one left by an earlier install*() call');
  } finally {
    gas.ScriptApp = originalScriptApp;
    gas.installAutomation = originalInstallAutomation;
    gas.installPhase2Trigger = originalInstallPhase2Trigger;
    gas.installSeanScoringAutomation = originalInstallSean;
    gas.installTomasScoringAutomation = originalInstallTomas;
    gas.installJoanaScoringAutomation = originalInstallJoana;
    gas.installBensScoringAutomation = originalInstallBens;
    configFlags.forEach((name) => { gas[name].ENABLED = originalEnabled[name]; });
  }
});

test('installAllReadyTriggers_ now installs the three phases that used to require manual setup (playbook review, weekly training summary, GHL sync) when their CONFIG.ENABLED is true — real gap found live 03/09/2026: all three had been installed by hand per their own file\'s "ONE-TIME SETUP" comment and were invisible to this function', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalInstallAutomation = gas.installAutomation;
  const originalInstallPhase2Trigger = gas.installPhase2Trigger;
  const originalInstallSean = gas.installSeanScoringAutomation;
  const originalInstallTomas = gas.installTomasScoringAutomation;
  const originalInstallJoana = gas.installJoanaScoringAutomation;
  const originalInstallBens = gas.installBensScoringAutomation;
  const configFlags = ['HANDOFF_CONFIG', 'INBOX_SLA_CONFIG', 'WEEKLY_SCORECARD_CONFIG', 'TRAINING_REVIEW_CONFIG',
    'TOMAS_TRANSCRIPT_REMINDER_CONFIG', 'DAILY_PRACTICE_CONFIG', 'RANDOM_CALIBRATION_CONFIG', 'REPLY_TRACKER_CONFIG'];
  const originalEnabled = {};
  const originalPlaybook = gas.PLAYBOOK_REVIEW_CONFIG.ENABLED;
  const originalSummary = gas.WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED;
  const originalGhl = gas.GHL_CONFIG.ENABLED;
  try {
    gas.ScriptApp = fakeScriptAppTriggers_([]);
    gas.installAutomation = () => {};
    gas.installPhase2Trigger = () => {};
    gas.installSeanScoringAutomation = () => {};
    gas.installTomasScoringAutomation = () => {};
    gas.installJoanaScoringAutomation = () => {};
    gas.installBensScoringAutomation = () => {};
    configFlags.forEach((name) => { originalEnabled[name] = gas[name].ENABLED; gas[name].ENABLED = false; });
    gas.PLAYBOOK_REVIEW_CONFIG.ENABLED = true;
    gas.WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED = true;
    gas.GHL_CONFIG.ENABLED = true;

    gas.installAllReadyTriggers_();

    const handlers = gas.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    assert.ok(handlers.indexOf('runWeeklyTrainingCycle') !== -1, 'the consolidated weekly training cycle trigger must now be installed');
    assert.equal(handlers.filter((h) => h === 'runWeeklyTrainingCycle').length, 1,
      'exactly one — the cycle handler owns Friday/Saturday/Monday by itself now');
    assert.ok(handlers.indexOf('runWeeklyTrainingSummaries') !== -1, 'weekly training summary trigger must now be installed');
    assert.ok(handlers.indexOf('syncGhlEmailAndDisposition_') !== -1, 'GHL sync trigger must now be installed');
  } finally {
    gas.ScriptApp = originalScriptApp;
    gas.installAutomation = originalInstallAutomation;
    gas.installPhase2Trigger = originalInstallPhase2Trigger;
    gas.installSeanScoringAutomation = originalInstallSean;
    gas.installTomasScoringAutomation = originalInstallTomas;
    gas.installJoanaScoringAutomation = originalInstallJoana;
    gas.installBensScoringAutomation = originalInstallBens;
    configFlags.forEach((name) => { gas[name].ENABLED = originalEnabled[name]; });
    gas.PLAYBOOK_REVIEW_CONFIG.ENABLED = originalPlaybook;
    gas.WEEKLY_TRAINING_SUMMARY_CONFIG.ENABLED = originalSummary;
    gas.GHL_CONFIG.ENABLED = originalGhl;
  }
});

test('reconcileComplianceBacklog_ does not let one logged row clear two different backlog entries for the same prospect', () => {
  const backlog = [
    { eventId: '', title: 'QC', prospectGuess: 'Jess Provencher', attendeeEmails: [], callDateLabel: '20/08/2026', firstFlaggedAt: '2026-08-20T22:00:00.000Z' },
    { eventId: '', title: 'Sales Call', prospectGuess: 'Jess Provencher', attendeeEmails: [], callDateLabel: '24/08/2026', firstFlaggedAt: '2026-08-24T22:00:00.000Z' }
  ];
  const loggedRowsAnyDate = [
    { rowIndex: 9, prospect: 'jess provencher', email: '', eventId: '', logged: true }
  ];
  const result = gas.reconcileComplianceBacklog_('Joana', backlog, loggedRowsAnyDate);
  assert.equal(result.length, 1, 'only ONE entry should be cleared by the one logged row');
});

test('appendNewBacklogEntries_ does not duplicate a bare-title event with a blank event ID on a second run', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const backlog = [
    { eventId: '', title: 'QC', prospectGuess: 'QC', attendeeEmails: [], callDateLabel: '25/08/2026', time: '09:00', firstFlaggedAt: '2026-08-25T22:00:00.000Z' }
  ];
  const missingToday = [
    { id: '', title: 'QC', prospectGuess: 'QC', attendeeEmails: [], start: new Date('2026-08-26T13:00:00Z') }
  ];
  const result = gas.appendNewBacklogEntries_(backlog, missingToday, '25/08/2026', gas.CONFIG.BUSINESS_TIMEZONE, '2026-08-26T22:00:00.000Z');
  assert.equal(result.length, 1, 'a blank-eventId bare-title event must dedupe by title+date+time, not accidentally re-add');
});

test('splitStaleBacklogEntries_ escalates entries at or past the age cap and keeps the rest', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const now = new Date('2026-08-26T22:00:00.000Z');
  const backlog = [
    { callDateLabel: '25/08/2026' }, // 1 day old -- keep
    { callDateLabel: '12/08/2026' }  // 14 days old -- escalate
  ];
  const { keep, escalate } = gas.splitStaleBacklogEntries_(backlog, now, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(keep.length, 1);
  assert.equal(escalate.length, 1);
  assert.equal(escalate[0].callDateLabel, '12/08/2026');
});

test('buildComplianceEmail_ sorts and labels by the call\'s own date, not by when it was flagged', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const repCfg = { name: 'Joana', email: 'joana@iconsofrealestate.com', spreadsheetId: 'SHEET_ID' };
  // Nicole's call is OLDER (12/08) but was flagged into the backlog LATER
  // (26/08, e.g. a retroactively-added calendar entry) than Joseph's newer
  // call (25/08) which was flagged first (25/08).
  const backlog = [
    { eventId: 'evt-2', title: 'QC / Joseph Bradley', prospectGuess: 'Joseph Bradley', callDateLabel: '25/08/2026', time: '10:00', firstFlaggedAt: '2026-08-25T22:00:00.000Z' },
    { eventId: 'evt-1', title: 'QC / Nicole Freed', prospectGuess: 'Nicole Freed', callDateLabel: '12/08/2026', time: '09:00', firstFlaggedAt: '2026-08-26T22:00:00.000Z' }
  ];
  const email = gas.buildComplianceEmail_(repCfg, backlog, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.ok(email.subject.indexOf('12/08/2026') !== -1, 'subject must name the call whose OWN date is oldest, not the one flagged first');
  assert.ok(email.body.indexOf('Nicole Freed') < email.body.indexOf('Joseph Bradley'), 'body must list by call date, not flag time');
});

test('buildAndMaybeSendPlaybookReview_-style watermark day comparison does not exclude a call dated the same day the watermark was set', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Watermark set Tue 25 Aug at 08:00 business time; a call dated that same
  // Tuesday (any time, since Call Date cells are date-only midnight) must
  // still count as "on or after" the watermark, not be excluded forever.
  const watermark = new Date('2026-08-25T12:00:00.000Z'); // 08:00 EDT
  const watermarkDayStart = gas.businessDayStart_(watermark, tz);
  const callDateSameDay = gas.dateAtMidnightInBusinessTimezone_(2026, 8, 25);
  assert.ok(!(callDateSameDay < watermarkDayStart), 'a call dated the same business day as the watermark must not be excluded');
});

test('stripFencesAndParseJson_ finds the real JSON object even when prose before it contains a brace (real bug: first-brace/last-brace slicing)', () => {
  const raw = 'Here is the evaluation {as requested}: {"reasoning": "ok", "call_quality_score": 4}';
  const parsed = gas.stripFencesAndParseJson_(raw);
  assert.equal(parsed.call_quality_score, 4);
});

test('stripFencesAndParseJson_ still works on the plain unfenced case with no stray braces', () => {
  const parsed = gas.stripFencesAndParseJson_('{"a": 1, "b": {"c": 2}}');
  assert.equal(parsed.a, 1);
  assert.equal(parsed.b.c, 2);
});

test('isValidLeadVerdict_/isValidScoreRange_ reject out-of-vocabulary and out-of-range model output (real bug: typeof-only checks let these through)', () => {
  assert.equal(gas.isValidLeadVerdict_('good_to_book'), true);
  assert.equal(gas.isValidLeadVerdict_('should screen out'), false, 'a space instead of the real enum value must be rejected');
  assert.equal(gas.isValidScoreRange_(4), true);
  assert.equal(gas.isValidScoreRange_(4.5), false, 'a non-integer score must be rejected');
  assert.equal(gas.isValidScoreRange_(8), false, 'an out-of-range severity must be rejected');
});

test('isValidJudgeSchema_ rejects a schema-shaped object with an invalid verdict or score even though every typeof check passes', () => {
  const base = {
    lead_quality: { verdict: 'good_to_book' },
    call_quality_score: 4,
    // discovery_adequate/understood_leads_business/confirmed_prior_discovery became
    // required on the shared rubric 03/09/2026 — see deriveDiscoveryFields_'s own test.
    // booked_discovery_call/lead_ready_with_money became required the same day —
    // see deriveBookingDecisionFields_'s own test.
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      discovery_adequate: true, understood_leads_business: true, confirmed_prior_discovery: true,
      booked_discovery_call: false, lead_ready_with_money: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
    manual_review_recommended: false,
    severity: 2
  };
  assert.equal(gas.isValidJudgeSchema_(base), true);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, base, { lead_quality: { verdict: 'should screen out' } })), false);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, base, { call_quality_score: 4.5 })), false);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, base, { severity: 8 })), false);
});

test('handleJudgeRetryError_ sleeps and lets a transport error retry, but throws once retries are exhausted (real bug: a rotated API key used to fall through to a fabricated score)', () => {
  const sleeps = [];
  gas.Utilities = { sleep: (ms) => sleeps.push(ms) };
  const transportErr = new gas.LlmTransportError_('LiteLLM proxy HTTP 401: unauthorized');

  // Not the last attempt: sleeps (backoff) and returns normally (the loop continues).
  gas.handleJudgeRetryError_(transportErr, 0, 1);
  assert.equal(sleeps.length, 1);

  // Last attempt: must throw instead of letting the loop fall through to the fabricated-score sentinel.
  assert.throws(() => gas.handleJudgeRetryError_(transportErr, 1, 1), /HTTP 401/);

  // A genuine parse/schema error (plain Error, not LlmTransportError_) is untouched — no sleep, no throw —
  // so the loop's existing retry-then-fallback-sentinel behavior for real parse failures is unchanged.
  sleeps.length = 0;
  gas.handleJudgeRetryError_(new Error('Parsed JSON missing required fields.'), 1, 1);
  assert.equal(sleeps.length, 0);
});

test('loadExistingLegacyKeys_ keys on rep too (real bug: two different reps closing the same prospect the same day collided into one key)', () => {
  const rows = [
    ['Anthony Camperi', '', '', new Date('2026-07-02T12:00:00Z'), 'Bens'],
    ['Anthony Camperi', '', '', new Date('2026-07-02T12:00:00Z'), 'Tomás']
  ];
  let call = 0;
  const fakeSheet = {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows })
  };
  gas.Utilities = { formatDate: realFormatDate };
  const keys = gas.loadExistingLegacyKeys_(fakeSheet);
  const keyList = Object.keys(keys);
  assert.equal(keyList.length, 2, 'Bens\' and Tomás\' calls for the same prospect/day must be two distinct keys, not one');
});

// ---------------------------------------------------------------------------
// Phase3_HandoffBrief.gs fixes (26/08/2026 silent-failure audit)
// ---------------------------------------------------------------------------

test('findMostRecentPriorScoredCall_ compares dates in business time, not the script default timezone (real bug: a row dated the day AFTER the event could still pass as "prior")', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  const col = { 'Prospect Name': 1, 'Transcript URL': 2, 'AI Feedback Summary': 3, 'Call Date': 4, Rep: 5, 'Call Type': 6 };
  // Row is dated 27/08/2026 -- the upcoming event is 26/08/2026 19:00 EDT.
  // With the naive constructor (script tz, ~11h early) this row's "comparable"
  // date used to land at 26/08 13:00 EDT, which is BEFORE the 19:00 event --
  // wrongly passing as a valid prior call for an event on an earlier day.
  const row = ['Jess Provencher', 'https://drive.google.com/file/d/abc123/view', 'Some feedback', '27/08/2026', 'Bens', 'QC'];
  const beforeDate = new Date('2026-08-26T23:00:00.000Z'); // 26/08 19:00 EDT
  const result = gas.findMostRecentPriorScoredCall_(col, [row], 'jess provencher', beforeDate);
  assert.equal(result, null, 'a row dated the day AFTER the event must never be selected as its prior call');
});

test('findMostRecentPriorScoredCall_ still finds a genuinely earlier row', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = { 'Prospect Name': 1, 'Transcript URL': 2, 'AI Feedback Summary': 3, 'Call Date': 4, Rep: 5, 'Call Type': 6 };
  const row = ['Jess Provencher', 'https://drive.google.com/file/d/abc123/view', 'Some feedback', '24/08/2026', 'Bens', 'QC'];
  const beforeDate = new Date('2026-08-26T23:00:00.000Z');
  const result = gas.findMostRecentPriorScoredCall_(col, [row], 'jess provencher', beforeDate);
  assert.ok(result, 'a genuinely earlier row must still be found');
  assert.equal(result.rep, 'Bens');
});

// ---------------------------------------------------------------------------
// Phase4_InboxSLA.gs fixes (26/08/2026 silent-failure audit)
// ---------------------------------------------------------------------------

test('subjectLooksExcluded_ does real substring matching, not Gmail\'s phrase-tokenized -subject: operator (real bug: -subject:"Accepted:" excluded any subject containing the bare WORD "Accepted" anywhere, even without the colon)', () => {
  assert.equal(gas.subjectLooksExcluded_('Accepted: Sync with Bens'), true, 'a genuine calendar-acceptance notification must still be excluded');
  assert.equal(gas.subjectLooksExcluded_('Re: Accepted — when can we record?'), false,
    'this real prospect reply has no "Accepted:" substring (no colon) -- Gmail\'s word-tokenized -subject:"Accepted:" used to drop it anyway because it matched on the bare word "Accepted"; a real substring check correctly keeps it');
  assert.equal(gas.subjectLooksExcluded_('Re: podcast next steps'), false, 'an unrelated real reply must not be excluded');
});

test('subjectLooksExcluded_ matches the full accented phrases now that they are not Gmail-phrase-tokenized (real bug: entries were truncated mid-word to dodge that tokenizer and could never match)', () => {
  assert.equal(gas.subjectLooksExcluded_('Fulano ingressou na sua Sala Pessoal de Reunião Zoom'), true);
  assert.equal(gas.subjectLooksExcluded_('Novo início de sessão detectado'), true);
});

test('subjectLooksExcluded_ excludes [Handoff Brief] threads — real complaint from Bens (31/08/2026): flagged "unanswered" for a briefing about someone ELSE\'s call he was only CC\'d on as the prior rep, which never asks for a reply, unlike the tracker/scorecard nags', () => {
  assert.equal(gas.subjectLooksExcluded_('Joana — [Handoff Brief] Crystal Gargiulo — your call in ~24 hrs'), true);
  assert.equal(gas.subjectLooksExcluded_('Re: Joana — [Handoff Brief] Crystal Gargiulo — your call in ~24 hrs'), true,
    'a reply-prefixed subject on the same thread must still match');
  // A tracker nudge DOES explicitly ask the rep to reply once done — must stay flagged, not get swept up by an over-broad fix.
  assert.equal(gas.subjectLooksExcluded_('Bens — [Action needed] Update your sales tracker — Joey Lamielle (4 call(s) still outstanding)'), false);
});

test('escapeHtml_ neutralizes a raw "Name <addr>" From header and stray angle brackets (real bug: unescaped fromRaw/subject broke HTML rendering in the nudge email)', () => {
  assert.equal(gas.escapeHtml_('Margaret Chen <margaret@bhhsrealty.com>'), 'Margaret Chen &lt;margaret@bhhsrealty.com&gt;');
  assert.equal(gas.escapeHtml_('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(gas.escapeHtml_('Tom & Jerry'), 'Tom &amp; Jerry');
});

test('repOwnEmails_ includes both a rep\'s primary address and their aliases, lowercased (real bug, 29/08/2026: Bens\' iconsofrealestate.com and ardorseo.com addresses are the SAME GSuite mailbox, so a reply sent from either one is still him answering)', () => {
  // Array.from(...) rebuilds the array in THIS (outer) realm before
  // comparing — repOwnEmails_'s own .map(...) return value is built inside
  // the vm sandbox's realm, and assert.deepEqual fails on that alone against
  // an outer-realm array literal, same cross-realm trap documented elsewhere
  // in this file for plain objects.
  assert.deepEqual(Array.from(gas.repOwnEmails_({ email: 'Bens@IconsOfRealEstate.com', aliases: ['Bens@ArdorSEO.com'] })),
    ['bens@iconsofrealestate.com', 'bens@ardorseo.com']);
});

test('repOwnEmails_ falls back to just the primary address when a rep has no aliases configured', () => {
  assert.deepEqual(Array.from(gas.repOwnEmails_({ email: 'sean@iconsofrealestate.com' })), ['sean@iconsofrealestate.com']);
});

test('findUnansweredThreadsForRep_ does NOT flag a thread the rep answered from their alias address (real bug, 29/08/2026: Bens replied to an agent from bens@ardorseo.com and was flagged as unanswered anyway, because the old check only compared against bens@iconsofrealestate.com)', () => {
  const repCfg = { name: 'Bens', email: 'bens@iconsofrealestate.com', aliases: ['bens@ardorseo.com'] };
  const oldGmailApiGet = gas.gmailApiGet_;
  const oldGetToken = gas.getGmailAccessTokenForUser_;
  gas.getGmailAccessTokenForUser_ = () => 'fake-token';
  gas.gmailApiGet_ = (token, path) => {
    if (path.indexOf('/threads?q=') === 0) return { threads: [{ id: 'thread-1' }] };
    // Bens' reply, sent from his ardorseo.com alias -- not his iconsofrealestate.com primary address.
    return {
      messages: [{
        internalDate: String(Date.now() - 48 * 3600000),
        payload: { headers: [{ name: 'From', value: 'Bens Olano <bens@ardorseo.com>' }, { name: 'Subject', value: 'Re: agent follow-up' }] }
      }]
    };
  };
  try {
    const unanswered = gas.findUnansweredThreadsForRep_(repCfg);
    assert.equal(unanswered.length, 0, 'a reply from the rep\'s own alias must count as answered, not flagged');
  } finally {
    gas.gmailApiGet_ = oldGmailApiGet;
    gas.getGmailAccessTokenForUser_ = oldGetToken;
  }
});

test('extractEmailAddresses_ pulls every address out of a comma-separated To/Cc header', () => {
  // Individual-field assertions, not assert.deepEqual on the whole array --
  // the array is built inside the vm sandbox's own realm (see gas_env.js's
  // Date comment) and deepEqual's constructor-identity check fails against
  // this file's plain array literals for realm reasons, not a real mismatch.
  const bracketed = gas.extractEmailAddresses_('Sean Church <sean@iconsofrealestate.com>, Kris Reid <kris@iconsofrealestate.com>');
  assert.equal(bracketed.length, 2);
  assert.equal(bracketed[0], 'sean@iconsofrealestate.com');
  assert.equal(bracketed[1], 'kris@iconsofrealestate.com');

  // No angle-bracket form at all -- bare comma-separated addresses.
  const bare = gas.extractEmailAddresses_('sean@iconsofrealestate.com, kris@iconsofrealestate.com');
  assert.equal(bare.length, 2);
  assert.equal(bare[0], 'sean@iconsofrealestate.com');
  assert.equal(bare[1], 'kris@iconsofrealestate.com');

  assert.equal(gas.extractEmailAddresses_('').length, 0);
  assert.equal(gas.extractEmailAddresses_(undefined).length, 0);
});

test('extractEmailAddresses_ captures BOTH forms when a header mixes a bracketed "Name <email>" entry with a bare address (real bug, 07/09/2026 code review: the old all-or-nothing branch silently dropped every bare address the moment ANY bracketed one was found in the same header)', () => {
  const mixed = gas.extractEmailAddresses_('Sean Church <sean@iconsofrealestate.com>, external.cc@lead.com');
  assert.equal(mixed.length, 2, 'the bare address must not be silently dropped just because the header also has a bracketed one');
  assert.ok(mixed.indexOf('sean@iconsofrealestate.com') !== -1);
  assert.ok(mixed.indexOf('external.cc@lead.com') !== -1);
});

test('formatEmailAgeLabel_ stays in hours under 48h, switches to rounded days at/over 48h (Kris\'s ask 02/09/2026: "hours get a bit crazy" past 48h)', () => {
  assert.equal(gas.formatEmailAgeLabel_(0), '0h old');
  assert.equal(gas.formatEmailAgeLabel_(24), '24h old');
  assert.equal(gas.formatEmailAgeLabel_(47), '47h old');
  assert.equal(gas.formatEmailAgeLabel_(48), '2d old');
  assert.equal(gas.formatEmailAgeLabel_(169), '7d old');
  assert.equal(gas.formatEmailAgeLabel_(656), '27d old');
});

// --- Task: no-show follow-up check (03/09/2026) ---
// Kris's ask: "There's five no shows, which is concerning. They've been
// followed up with properly. We need to be able to check that... Same with
// Sean and Tomas."

test('findRecentNoShowRows_ only picks up No-show rows inside the lookback window, across every rep, and skips a row with no parseable Call Date rather than guessing', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const blankRow = () => new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  const setRow = (fields) => {
    const row = blankRow();
    Object.keys(fields).forEach((h) => { row[col[h] - 1] = fields[h]; });
    return row;
  };

  const rows = [
    setRow({ 'Prospect Name': 'Recent No-show', 'Prospect Email': 'a@example.com', Rep: 'Sean', 'Call Date': '01/09/2026', 'Outcome Disposition': 'No-show' }),
    setRow({ 'Prospect Name': 'Old No-show', 'Prospect Email': 'b@example.com', Rep: 'Joana', 'Call Date': '01/01/2026', 'Outcome Disposition': 'No-show' }),
    setRow({ 'Prospect Name': 'Not A No-show', 'Prospect Email': 'c@example.com', Rep: 'Tomás', 'Call Date': '01/09/2026', 'Outcome Disposition': 'Sold' }),
    setRow({ 'Prospect Name': 'No Date', 'Prospect Email': 'd@example.com', Rep: 'Bens', 'Call Date': '', 'Outcome Disposition': 'No-show' })
  ];
  const cutoff = new gas.Date('2026-08-25T00:00:00Z');
  const results = gas.findRecentNoShowRows_(rows, col, cutoff);

  assert.equal(results.length, 1, 'only the recent, real No-show with a parseable date should survive');
  assert.equal(results[0].prospectName, 'Recent No-show');
  assert.equal(results[0].rep, 'Sean');
});

test('findRecentNoShowRows_ reads a REAL Date-object Call Date cell, not just "dd/MM/yyyy" text (same live bug class the GHL hygiene check found 03/09/2026 — getValues() hands back an actual Date for a genuine Sheets date cell, and this function used to have its own text-only parser)', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const blankRow = () => new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  const setRow = (fields) => {
    const row = blankRow();
    Object.keys(fields).forEach((h) => { row[col[h] - 1] = fields[h]; });
    return row;
  };

  const rows = [
    setRow({
      'Prospect Name': 'Recent No-show', 'Prospect Email': 'a@example.com', Rep: 'Sean',
      'Call Date': new gas.Date(gas.Date.UTC(2026, 8, 1, 12, 0, 0)), // gas.Date -- real Date, own realm (see parseSalesCallLogDate_'s own tests)
      'Outcome Disposition': 'No-show'
    })
  ];
  const cutoff = new gas.Date('2026-08-25T00:00:00Z');
  gas.Utilities = { formatDate: realFormatDate };
  const results = gas.findRecentNoShowRows_(rows, col, cutoff);

  assert.equal(results.length, 1, 'a real Date-object cell must be recognized, not silently dropped as unparseable');
  assert.equal(results[0].callDateLabel, '01/09/2026');
});

test('repEmailForFollowUpCheck_ covers Tomás (missing from CONFIG.REPS, unlike Bens/Joana/Sean) without guessing for an unknown rep', () => {
  assert.equal(gas.repEmailForFollowUpCheck_('Sean'), gas.repEmailByName_('Sean'));
  assert.equal(gas.repEmailForFollowUpCheck_('Tomás'), gas.CONFIG.TOMAS_EMAIL);
  assert.equal(gas.repEmailForFollowUpCheck_('Tomas'), gas.CONFIG.TOMAS_EMAIL, 'must work without the accent too');
  assert.equal(gas.repEmailForFollowUpCheck_('Some Rando'), null, 'must never guess an email for an unrecognized rep');
});

test('buildNoShowFollowUpReport_ sections each status separately and is honest that "followed up" only ever means an email was found, never proof of a phone call', () => {
  const results = [
    { prospectName: 'A', rep: 'Sean', callDateLabel: '01/09/2026', status: 'not_followed_up' },
    { prospectName: 'B', rep: 'Joana', callDateLabel: '01/09/2026', status: 'followed_up' },
    { prospectName: 'C', rep: 'Tomás', callDateLabel: '01/09/2026', status: 'unverifiable_no_prospect_email' }
  ];
  const report = gas.buildNoShowFollowUpReport_(results, 14);

  assert.ok(report.subject.indexOf('1 unconfirmed of 3') !== -1, 'subject must surface the actionable count up front');
  assert.ok(report.body.indexOf('A') !== -1 && report.body.indexOf('B') !== -1 && report.body.indexOf('C') !== -1);
  const notFollowedIdx = report.body.indexOf('NOT followed up');
  const aIdx = report.body.indexOf('A (Sean');
  const followedIdx = report.body.indexOf('followed up (an email');
  const bIdx = report.body.indexOf('B (Joana');
  assert.ok(notFollowedIdx !== -1 && aIdx > notFollowedIdx && aIdx < followedIdx, 'A must land in the NOT-followed-up section, not the followed-up one');
  assert.ok(bIdx > followedIdx, 'B must land in the followed-up section');
  assert.ok(report.body.toLowerCase().indexOf('cannot see a phone call') !== -1,
    'must be explicit that this is a starting point for review, not final proof');
});

test('repIsToRecipient_ checks the rep\'s own addresses (including aliases) against the To list, not Cc', () => {
  const repCfg = { name: 'Bens', email: 'bens@iconsofrealestate.com', aliases: ['bens@ardorseo.com'] };
  assert.equal(gas.repIsToRecipient_(repCfg, ['bens@iconsofrealestate.com']), true);
  assert.equal(gas.repIsToRecipient_(repCfg, ['bens@ardorseo.com']), true, 'an alias address counts too');
  assert.equal(gas.repIsToRecipient_(repCfg, ['joana@iconsofrealestate.com']), false);
  assert.equal(gas.repIsToRecipient_(repCfg, []), false);
});

test('findUnansweredThreadsForRep_ does NOT flag a thread where the rep is only CC\'d, never actually addressed (real complaint from Bens, 31/08/2026: flagged for threads he had no reason to reply to — someone else\'s outreach conversation he was just CC\'d on)', () => {
  const repCfg = { name: 'Sean', email: 'sean@iconsofrealestate.com', aliases: [] };
  const oldGmailApiGet = gas.gmailApiGet_;
  const oldGetToken = gas.getGmailAccessTokenForUser_;
  gas.getGmailAccessTokenForUser_ = () => 'fake-token';
  gas.gmailApiGet_ = (token, path) => {
    if (path.indexOf('/threads?q=') === 0) return { threads: [{ id: 'thread-cc-only' }] };
    // Joana's own outreach thread -- addressed TO the lead, Sean only CC'd.
    return {
      messages: [{
        internalDate: String(Date.now() - 48 * 3600000),
        payload: {
          headers: [
            { name: 'From', value: 'Eileen Decelle <eileen.findyourhome@gmail.com>' },
            { name: 'Subject', value: 'Re: Missed Call' },
            { name: 'To', value: 'Joana Peixe <joana@iconsofrealestate.com>' },
            { name: 'Cc', value: 'Sean Church <sean@iconsofrealestate.com>, Tomás Fonseca <tomas@iconsofrealestate.com>' }
          ]
        }
      }]
    };
  };
  try {
    const unanswered = gas.findUnansweredThreadsForRep_(repCfg);
    assert.equal(unanswered.length, 0, 'a thread addressed to someone else, with the rep only CC\'d, must not be flagged as the rep\'s to answer');
  } finally {
    gas.gmailApiGet_ = oldGmailApiGet;
    gas.getGmailAccessTokenForUser_ = oldGetToken;
  }
});

test('findUnansweredThreadsForRep_ still flags a thread where the rep IS a To recipient, and stays conservative (still flags) when To is empty/unparseable', () => {
  const repCfg = { name: 'Sean', email: 'sean@iconsofrealestate.com', aliases: [] };
  const oldGmailApiGet = gas.gmailApiGet_;
  const oldGetToken = gas.getGmailAccessTokenForUser_;
  gas.getGmailAccessTokenForUser_ = () => 'fake-token';

  gas.gmailApiGet_ = (token, path) => {
    if (path.indexOf('/threads?q=') === 0) return { threads: [{ id: 'thread-to-sean' }] };
    return {
      messages: [{
        internalDate: String(Date.now() - 48 * 3600000),
        payload: {
          headers: [
            { name: 'From', value: 'A Lead <lead@example.com>' },
            { name: 'Subject', value: 'Question about pricing' },
            { name: 'To', value: 'Sean Church <sean@iconsofrealestate.com>' }
          ]
        }
      }]
    };
  };
  try {
    assert.equal(gas.findUnansweredThreadsForRep_(repCfg).length, 1, 'a thread genuinely addressed to the rep must still be flagged');
  } finally {
    gas.gmailApiGet_ = oldGmailApiGet;
  }

  // No To header at all (unparseable/missing) -- must NOT silently suppress a real nag.
  gas.gmailApiGet_ = (token, path) => {
    if (path.indexOf('/threads?q=') === 0) return { threads: [{ id: 'thread-no-to' }] };
    return {
      messages: [{
        internalDate: String(Date.now() - 48 * 3600000),
        payload: { headers: [{ name: 'From', value: 'A Lead <lead@example.com>' }, { name: 'Subject', value: 'No To header' }] }
      }]
    };
  };
  try {
    assert.equal(gas.findUnansweredThreadsForRep_(repCfg).length, 1, 'an empty/unparseable To must stay conservative, not suppress the nag');
  } finally {
    gas.gmailApiGet_ = oldGmailApiGet;
    gas.getGmailAccessTokenForUser_ = oldGetToken;
  }
});

// ---------------------------------------------------------------------------
// Phase5_WeeklyScorecard.gs fixes (26/08/2026 silent-failure audit)
// ---------------------------------------------------------------------------

test('shiftBusinessDate_ steps by whole calendar days across a DST transition (real bug: raw 24h-ms arithmetic on the week boundary was off by an hour and dropped a whole Monday)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Mon 2 Nov 2026 -- the Monday right after the US fall-back DST transition (1 Nov).
  const weekEnd = gas.dateAtMidnightInBusinessTimezone_(2026, 11, 2);
  const start = gas.shiftBusinessDate_(weekEnd, tz, -7);
  const expected = gas.dateAtMidnightInBusinessTimezone_(2026, 10, 26); // Mon 26 Oct 2026, exact business-tz midnight
  assert.equal(start.getTime(), expected.getTime(), 'must land on the exact business-tz midnight of the prior Monday, not an hour off');
});

test('getWeekBounds_ produces a 7-day-exactly window across the spring-forward DST transition too', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = gas.CONFIG.BUSINESS_TIMEZONE;
  // Mon 9 Mar 2026 -- the Monday right after the US spring-forward transition (8 Mar).
  const now = new Date('2026-03-09T16:00:00Z');
  const week = gas.getWeekBounds_(now, tz);
  const expectedStart = gas.dateAtMidnightInBusinessTimezone_(2026, 3, 2);
  assert.equal(week.start.getTime(), expectedStart.getTime());
});

test('isExplicitlyFalse_ recognizes real false plus common text equivalents, but not blank/unrelated values', () => {
  assert.equal(gas.isExplicitlyFalse_(false), true);
  assert.equal(gas.isExplicitlyFalse_('No'), true);
  assert.equal(gas.isExplicitlyFalse_('FALSE'), true);
  assert.equal(gas.isExplicitlyFalse_(true), false);
  assert.equal(gas.isExplicitlyFalse_(''), false);
  assert.equal(gas.isExplicitlyFalse_('Yes'), false);
});

test('computeRepWeeklyStats_ treats "None" (any case) as no failure mode, and does not miscount a non-Date Call Date into the historic baseline', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4, pfm: 'None', askedForClose: true, objectionsHandled: true }),
    // A pasted/typed Call Date that never became a real Date object.
    ['Sean', 'B', '15/08/2026', 3, '', true, true, '', '']
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.weekFailureModes.length, 0, '"None" must not be pushed as a real failure mode');
  assert.equal(stats.weekCalls.length, 1, 'the non-Date row must be excluded from this week entirely');
  // Still a genuinely scored call, so it counts in the all-time figure --
  // what it must NOT do is get miscounted into the date-dependent
  // "before this week" baseline, since we can't tell which side of the
  // week boundary it falls on.
  assert.equal(stats.historicCount, 2);
  assert.equal(stats.historicAvgBeforeThisWeek, null, 'with no OTHER prior call, the baseline must be null, not corrupted by the unusable-date row');
});

test('computeRepWeeklyStats_ matches Rep case-insensitively (real bug: a hand-typed "sean" vanished from every rep\'s scorecard)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [scorecardRow(gas, { rep: 'sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4, askedForClose: true, objectionsHandled: true })];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.weekCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Phase 8: Reply Tracker
// ---------------------------------------------------------------------------

test('extractHtmlBodyAsText_ falls back to a tag-stripped text/html part when there is no text/plain part (real bug L-13: an HTML-only reply came back as "" from extractPlainTextBody_, so the classifier got no reply text to judge)', () => {
  const originalUtilities = gas.Utilities;
  gas.Utilities = {
    base64DecodeWebSafe: (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
    newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') })
  };
  try {
    const html = '<html><body><style>.x{color:red}</style><p>Sure, <b>tell me more</b>!</p></body></html>';
    const payload = {
      parts: [
        { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64').replace(/\+/g, '-').replace(/\//g, '_') } }
      ]
    };
    const text = gas.extractHtmlBodyAsText_(payload);
    assert.match(text, /Sure, tell me more/);
    assert.ok(text.indexOf('color:red') === -1, 'stray <style> block contents must not leak into the extracted text');
  } finally {
    gas.Utilities = originalUtilities;
  }
});

test('computeReplyStats_ flip-rate compares against the negative reply\'s own date, not just whichever row happens to be first in the sheet for that lead (real bug: rows are appended in classification/thread-list order, not chronological order)', () => {
  // Sheet append order (NOT chronological): a later positive reply got
  // classified and appended before an earlier negative one for the same lead.
  const rows = [
    { date: new Date('2026-08-20T00:00:00Z'), leadEmail: 'lead@example.com', sentiment: 'positive' },
    { date: new Date('2026-08-10T00:00:00Z'), leadEmail: 'lead@example.com', sentiment: 'negative' }
  ];
  const stats = gas.computeReplyStats_(rows, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'));
  assert.equal(stats.pctNegativeTurnedPositive, 1, 'the Aug 20 positive comes after the Aug 10 negative, so this lead should count as flipped');
});

test('computeReplyStats_ does not count a positive reply that came BEFORE the in-range negative reply as a "flip"', () => {
  const rows = [
    { date: new Date('2026-08-01T00:00:00Z'), leadEmail: 'lead@example.com', sentiment: 'positive' },
    { date: new Date('2026-08-10T00:00:00Z'), leadEmail: 'lead@example.com', sentiment: 'negative' }
  ];
  const stats = gas.computeReplyStats_(rows, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'));
  assert.equal(stats.pctNegativeTurnedPositive, 0, 'the only positive reply predates the negative one, so this is not a flip');
});

test('computeReplyStats_ computes booking percentages against the leads who REPLIED in this period, not the booking date, when a bookingOutcomes map is supplied', () => {
  const rows = [
    { date: new Date('2026-08-05T00:00:00Z'), leadEmail: 'self@example.com', sentiment: 'positive' },
    { date: new Date('2026-08-06T00:00:00Z'), leadEmail: 'rep@example.com', sentiment: 'positive' },
    { date: new Date('2026-08-07T00:00:00Z'), leadEmail: 'unbooked@example.com', sentiment: 'negative' }
  ];
  const bookingOutcomes = { 'self@example.com': 'self', 'rep@example.com': 'rep' };
  const stats = gas.computeReplyStats_(rows, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'), bookingOutcomes);
  assert.equal(stats.bookingStats.repliedLeadCount, 3);
  assert.equal(stats.bookingStats.pctBookedThemselves, 1 / 3);
  assert.equal(stats.bookingStats.pctBookedToQCByRep, 1 / 3);
});

test('computeReplyStats_ leaves bookingStats null when no bookingOutcomes map is supplied (real bug: booking percentages must read as unwired, not silently zero)', () => {
  const rows = [{ date: new Date('2026-08-05T00:00:00Z'), leadEmail: 'lead@example.com', sentiment: 'positive' }];
  const stats = gas.computeReplyStats_(rows, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'));
  assert.equal(stats.bookingStats, null);
});

test('loadLoggedMessageIds_ dedupes by the Message ID column, not Thread ID (real bug H-05: dedupe-by-thread froze a lead\'s sentiment at their first reply forever, since Gmail threads accumulate messages under the same thread id)', () => {
  const rows = [
    ['2026-08-10', 'thread-1', 'lead@example.com', 'Re: intro', 'negative', 'no thanks', 'lead@example.com', 'msg-1'],
    ['2026-08-20', 'thread-1', 'lead@example.com', 'Re: intro', 'positive', 'actually interested', 'lead@example.com', 'msg-2']
  ];
  const sheet = {
    getLastRow: () => rows.length + 1,
    getRange: (row, col, numRows, numCols) => ({ getValues: () => rows.map((r) => [r[col - 1]]) })
  };
  const logged = gas.loadLoggedMessageIds_(sheet);
  assert.deepEqual(Object.keys(logged).sort(), ['msg-1', 'msg-2'],
    'both messages on the same thread must be tracked as separately-logged, not collapsed into one thread-id entry');
});

test('classifyNewReplies leaves Lead Email blank, not the relay address, when no quote header can be found (real bug, 29/08/2026, root cause of the reply tracker\'s stuck-at-0% booking stat: every failed extraction used to fall back to extractEmailAddress_(msg.fromRaw), which is always network@ardorseo.com, silently making every such row look like the SAME "lead")', () => {
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalUtilities = gas.Utilities;
  const originalGetToken = gas.getGmailAccessTokenForUser_;
  const originalGmailApiGet = gas.gmailApiGet_;
  const originalClassifyReply = gas.classifyReply_;
  try {
    const appended = [];
    const fakeSheet = {
      getLastRow: () => 1, // empty — nothing logged yet
      getRange: () => ({ getValues: () => [] }),
      appendRow: (row) => appended.push(row)
    };
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet, insertSheet: () => fakeSheet }) };
    gas.Utilities = {
      base64DecodeWebSafe: (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      sleep: () => {}
    };
    gas.getGmailAccessTokenForUser_ = () => 'fake-token';
    gas.classifyReply_ = () => ({ sentiment: 'negative', reasoning: 'No reply text, likely a bounce.' });
    const bodyB64 = Buffer.from('Please take me off this list.').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    gas.gmailApiGet_ = (token, path) => {
      if (path.indexOf('/threads?q=') === 0) return { threads: [{ id: 't1' }] };
      if (path === '/threads/t1?format=full') {
        return {
          messages: [{
            id: 'm1',
            internalDate: '1000',
            payload: {
              mimeType: 'text/plain',
              body: { data: bodyB64 },
              headers: [
                { name: 'From', value: '"Joana Peixe" via Network <network@ardorseo.com>' },
                { name: 'Subject', value: 'Fwd: Stop' }
              ]
            }
          }]
        };
      }
      throw new Error('unexpected gmailApiGet_ path: ' + path);
    };

    gas.classifyNewReplies();

    assert.equal(appended.length, 1);
    const leadEmailCol = gas.REPLY_TRACKER_HEADERS.indexOf('Lead Email');
    assert.equal(appended[0][leadEmailCol], '', 'no quote header in this body — Lead Email must be blank, not the relay address');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.Utilities = originalUtilities;
    gas.getGmailAccessTokenForUser_ = originalGetToken;
    gas.gmailApiGet_ = originalGmailApiGet;
    gas.classifyReply_ = originalClassifyReply;
  }
});

test('buildReplyMetricsReportBody_ reports the 7-day and 30-day figures as a true per-day average, not a raw window total (real bug, 29/08/2026: labeled "total" was already honest, but Kris asked for it as an actual average instead)', () => {
  const rows = [];
  const now = new Date('2026-08-29T21:00:00Z');
  for (let i = 0; i < 14; i++) {
    rows.push({ date: new Date(now.getTime() - i * 24 * 3600 * 1000), leadEmail: 'lead' + i + '@example.com', sentiment: i % 2 === 0 ? 'positive' : 'negative', subject: 'Re: outreach', reasoning: 'r' });
  }
  const originalBookingTabs = gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS;
  const originalUtilities = gas.Utilities;
  gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = []; // reconcileBookingOutcomes_ short-circuits without touching SpreadsheetApp
  gas.Utilities = { formatDate: (d, tz, pattern) => (pattern === 'dd/MM/yy' ? '29/08/26' : realFormatDate(d, tz, pattern)) };
  try {
    const periods = gas.computeReplyMetricsPeriods_(rows, now, 'America/New_York');
    // Divided by actualDays, not a flat 7/30 (real bug fixed 30/08/2026) — this
    // test's own data only spans 14 days back, so actualDays legitimately
    // differs from the nominal window size for both periods.
    const expectedWeekAvg = (periods.week.count / periods.week.actualDays).toFixed(1);
    const expectedMonthAvg = (periods.month.count / periods.month.actualDays).toFixed(1);
    const body = gas.buildReplyMetricsReportBody_(rows, now, 'America/New_York');
    assert.match(body, new RegExp('Rolling 7-day average: ' + expectedWeekAvg + ' reply\\(ies\\)/day avg'));
    assert.match(body, new RegExp('Rolling 30-day average: ' + expectedMonthAvg + ' reply\\(ies\\)/day avg'));
    assert.ok(body.indexOf('Rolling 7-day total') === -1, 'must not still say "total" anywhere');
    assert.ok(body.indexOf('Rolling 30-day total') === -1, 'must not still say "total" anywhere');
  } finally {
    gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = originalBookingTabs;
    gas.Utilities = originalUtilities;
  }
});

test('actualDaysCovered_ clamps to the earliest logged reply date, not the nominal window size (real bug, 30/08/2026: a 30-day window computed before the tracker had 30 days of history divided by a flat 30 and understated the average)', () => {
  const windowStart = new Date('2026-08-01T00:00:00Z');
  const windowEnd = new Date('2026-08-31T00:00:00Z'); // nominal 30-day window
  // Tracker only started logging 20/08/2026 — earliestRowDate is inside the window.
  const earliestRowDate = new Date('2026-08-20T00:00:00Z');
  const days = gas.actualDaysCovered_(windowStart, windowEnd, earliestRowDate);
  assert.equal(days, 11, 'should count only from the earliest logged reply, not the full nominal 30-day window');
});

test('actualDaysCovered_ falls back to the nominal window size once the tracker has run longer than the window (earliestRowDate before windowStart)', () => {
  const windowStart = new Date('2026-08-01T00:00:00Z');
  const windowEnd = new Date('2026-08-31T00:00:00Z');
  const earliestRowDate = new Date('2026-01-01T00:00:00Z'); // long before the window
  const days = gas.actualDaysCovered_(windowStart, windowEnd, earliestRowDate);
  assert.equal(days, 30, 'earliestRowDate before the window should not shrink or extend the nominal window');
});

test('actualDaysCovered_ clamps to a minimum of 1 day so a same-day-old tracker never divides by zero', () => {
  const windowStart = new Date('2026-08-30T00:00:00Z');
  const windowEnd = new Date('2026-08-31T00:00:00Z');
  const earliestRowDate = new Date('2026-08-30T12:00:00Z'); // first reply logged mid-window, close to windowEnd
  const days = gas.actualDaysCovered_(windowStart, windowEnd, earliestRowDate);
  assert.ok(days >= 1, 'must never return less than 1 day');
});

test('buildReplyMetricsReportBody_ and buildReplyMetricsReportHtml_ show only the averages for the rolling 7/30-day periods, with no example replies listed (Kris\'s ask 02/09/2026: "don\'t need examples on the 7 days / 30 days, that is just to show the averages" — reverses the earlier 30/08/2026 ask)', () => {
  const now = new Date('2026-08-29T21:00:00Z');
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({ date: new Date(now.getTime() - i * 3600 * 1000), leadEmail: 'pos' + i + '@example.com', sentiment: 'positive', subject: 'Positive reply ' + i, reasoning: 'r' + i });
  }
  const originalBookingTabs = gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS;
  const originalUtilities = gas.Utilities;
  gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = [];
  gas.Utilities = { formatDate: (d, tz, pattern) => (pattern === 'dd/MM/yy' ? '29/08/26' : realFormatDate(d, tz, pattern)) };
  try {
    const body = gas.buildReplyMetricsReportBody_(rows, now, 'America/New_York');
    assert.ok(body.indexOf('Examples —') === -1, 'plain-text body must not show any "Examples —" section at all');
    const bodyAfterWeek = body.split('Rolling 7-day average')[1];
    assert.ok(bodyAfterWeek.indexOf('Positive reply') === -1, 'individual replies must not be listed under the rolling averages');

    const html = gas.buildReplyMetricsReportHtml_(rows, now, 'America/New_York');
    assert.ok(html.indexOf('Examples —') === -1, 'HTML body must not show any "Examples —" section at all');
    const htmlAfterWeek = html.split('Rolling 7-day average')[1];
    assert.ok(htmlAfterWeek.indexOf('Positive reply') === -1, 'individual replies must not be listed under the rolling averages');
  } finally {
    gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = originalBookingTabs;
    gas.Utilities = originalUtilities;
  }
});

test('buildReplyMetricsReportBody_ and buildReplyMetricsReportHtml_ list today\'s individual positive and negative replies by subject/lead (Kris\'s ask 29/08/2026, so Joana can confirm each classification)', () => {
  const now = new Date('2026-08-29T21:00:00Z');
  const rows = [
    { date: now, leadEmail: 'sabrina@example.com', sentiment: 'positive', subject: 'Fwd: Re: Sabrina, hosting a podcast?', reasoning: 'Explicitly interested.' },
    { date: now, leadEmail: 'marilyn@example.com', sentiment: 'negative', subject: 'Fwd: Re: Marilyn, hosting a podcast?', reasoning: 'Not interested.' }
  ];
  const originalBookingTabs = gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS;
  const originalUtilities = gas.Utilities;
  gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = [];
  gas.Utilities = { formatDate: (d, tz, pattern) => (pattern === 'dd/MM/yy' ? '29/08/26' : realFormatDate(d, tz, pattern)) };
  try {
    const body = gas.buildReplyMetricsReportBody_(rows, now, 'America/New_York');
    assert.match(body, /Today — positive:\n {2}- Fwd: Re: Sabrina, hosting a podcast\? — sabrina@example\.com — Explicitly interested\./);
    assert.match(body, /Today — negative:\n {2}- Fwd: Re: Marilyn, hosting a podcast\? — marilyn@example\.com — Not interested\./);

    const html = gas.buildReplyMetricsReportHtml_(rows, now, 'America/New_York');
    assert.match(html, /Today — positive/);
    assert.match(html, /Sabrina, hosting a podcast\?/);
    assert.match(html, /sabrina@example\.com/);
    assert.match(html, /Today — negative/);
    assert.match(html, /Marilyn, hosting a podcast\?/);
  } finally {
    gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = originalBookingTabs;
    gas.Utilities = originalUtilities;
  }
});

test('sendReplyMetricsReport_ cc\'s Joana on the daily digest, alongside Tomás (Kris\'s ask 29/08/2026: she should be able to confirm the AI\'s classifications are right)', () => {
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalGuardedSend = gas.guardedSend_;
  const originalBookingTabs = gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS;
  const originalEnabled = gas.REPLY_TRACKER_CONFIG.ENABLED;
  const originalUtilities = gas.Utilities;
  try {
    gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = [];
    gas.REPLY_TRACKER_CONFIG.ENABLED = true;
    // 'EEE' pinned to a real weekday — sendReplyMetricsReport_ now checks this
    // (30/08/2026 weekday-only fix) before anything else, so leaving it to fall
    // through to realFormatDate would make this test's pass/fail depend on
    // whatever day it happens to run, which is exactly the flakiness a fixed
    // stub avoids.
    gas.Utilities = {
      formatDate: (d, tz, pattern) => (pattern === 'dd/MM/yy' ? '29/08/26' : pattern === 'EEE' ? 'Wed' : realFormatDate(d, tz, pattern))
    };
    const fakeSheet = { getLastRow: () => 1, getRange: () => ({ getValues: () => [] }) };
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet, insertSheet: () => fakeSheet }) };
    let captured = null;
    gas.guardedSend_ = (to, subject, body, options) => { captured = { to, subject, options }; return true; };

    gas.sendReplyMetricsReport_();

    assert.equal(captured.to, gas.CONFIG.KRIS_EMAIL);
    assert.ok(captured.options.cc.indexOf(gas.CONFIG.JOANA_EMAIL) !== -1, 'Joana must be cc\'d');
    assert.ok(captured.options.cc.indexOf(gas.CONFIG.TOMAS_EMAIL) !== -1, 'Tomás must still be cc\'d');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.guardedSend_ = originalGuardedSend;
    gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = originalBookingTabs;
    gas.REPLY_TRACKER_CONFIG.ENABLED = originalEnabled;
    gas.Utilities = originalUtilities;
  }
});

test('sendReplyMetricsReport_ skips entirely on a weekend (business timezone), even when ENABLED is true (real bug, 30/08/2026: the "Sales Review - Daily Tracker" email went out on a Sunday)', () => {
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalGuardedSend = gas.guardedSend_;
  const originalEnabled = gas.REPLY_TRACKER_CONFIG.ENABLED;
  const originalUtilities = gas.Utilities;
  try {
    gas.REPLY_TRACKER_CONFIG.ENABLED = true;
    gas.Utilities = { formatDate: (d, tz, pattern) => (pattern === 'EEE' ? 'Sun' : realFormatDate(d, tz, pattern)) };
    // Making SpreadsheetApp throw proves the function exits before touching
    // the sheet at all, not just before sending.
    gas.SpreadsheetApp = { openById: () => { throw new Error('must not even open the sheet on a weekend'); } };
    gas.guardedSend_ = () => { throw new Error('must not send on a weekend'); };

    gas.sendReplyMetricsReport_(); // must not throw
    assert.ok(true, 'returned cleanly without touching the sheet or sending');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.guardedSend_ = originalGuardedSend;
    gas.REPLY_TRACKER_CONFIG.ENABLED = originalEnabled;
    gas.Utilities = originalUtilities;
  }
});

// ---------------------------------------------------------------------------
// Phase 9: GoHighLevel sync. Stage names below are the REAL ones recorded in
// GHL_PIPELINE_MAP.md's survey of the live CRM, not invented examples.
// ---------------------------------------------------------------------------

test('ghlStageToOutcomeDisposition_ reads "Not Taken" as a no-show, NOT as a completed call (the substring trap: "Sales Call Not Taken" contains "Taken")', () => {
  // If the bare "taken" check ever runs before the "not taken" one, every
  // no-show silently becomes a completed call — which would corrupt the
  // exact funnel numbers this sync exists to make trustworthy.
  assert.equal(gas.ghlStageToOutcomeDisposition_('Sales Call Not Taken'), 'No-show');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Qualification Call Not Taken'), 'No-show');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Discovery Call Not Taken'), 'No-show');
  assert.equal(gas.ghlStageToOutcomeDisposition_('2nd Call Not Taken'), 'No-show');
});

test('ghlStageToOutcomeDisposition_ maps every real no-show spelling in the live CRM', () => {
  // The CRM uses "No Show", "No-Show" and "Not Taken" interchangeably
  // across pipelines — all three mean the same thing.
  assert.equal(gas.ghlStageToOutcomeDisposition_('No Show'), 'No-show');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Sales Call No-Show'), 'No-show');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Second Sales Call No-Show'), 'No-show');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Qualification Call - No Show'), 'No-show');
});

test('ghlStageToOutcomeDisposition_ maps closed stages, case-insensitively (the CRM spells them "Closed Won" and "Closed won")', () => {
  assert.equal(gas.ghlStageToOutcomeDisposition_('Closed Won'), 'Sold');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Closed won'), 'Sold');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Closed lost'), 'Not Sold');
});

test('ghlStageToOutcomeDisposition_ maps reschedule/callback stages to Follow-up', () => {
  assert.equal(gas.ghlStageToOutcomeDisposition_('Sales call - Reschedule'), 'Follow-up');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Qualification Call Reschedule'), 'Follow-up');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Need to Reschedule'), 'Follow-up');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Callback'), 'Follow-up');
  assert.equal(gas.ghlStageToOutcomeDisposition_('Moving Forward Later'), 'Follow-up');
});

test('ghlStageToOutcomeDisposition_ infers NOTHING from a call that merely happened or is merely booked (the outcome is decided by a later stage)', () => {
  // "Taken"/"Recorded" mean the call occurred; whether it sold is decided
  // downstream. Writing a disposition here would be a guess, and a wrong
  // disposition corrupts the funnel worse than a blank one.
  assert.equal(gas.ghlStageToOutcomeDisposition_('Sales Call Taken'), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_('Podcast Recorded'), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_('Qualification Call Taken (No SC)'), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_('Sales Call - Booked'), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_('Dial 1'), null);
});

test('ghlStageToOutcomeDisposition_ returns null for the stages deliberately left unmapped pending Kris\'s confirmation, and for junk input', () => {
  assert.equal(gas.ghlStageToOutcomeDisposition_('Failed Deal Form Filled'), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_('Pre-Interview Reject'), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_('Not Qualified/Valid'), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_(''), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_(null), null);
  assert.equal(gas.ghlStageToOutcomeDisposition_(undefined), null);
});

// ---------------------------------------------------------------------------
// Phase 9: GHL sync
// ---------------------------------------------------------------------------

test('buildGhlStageLookup_ builds a stageId -> {pipelineName, stageName, disposition} map straight from the live pipelines response, never hardcoded', () => {
  const pipelines = [
    {
      name: 'Cold Calling',
      stages: [
        { id: 'stage-1', name: 'Qualification Call Not Taken' },
        { id: 'stage-2', name: 'Closed Won' }
      ]
    },
    {
      name: 'ICONS Podcast',
      stages: [
        { id: 'stage-3', name: 'No Show' }
      ]
    }
  ];
  const lookup = gas.buildGhlStageLookup_(pipelines);
  // Object.assign({}, ...) (not a direct deepEqual on the vm-sandbox object
  // itself) because `lookup`'s entries are plain-object literals built
  // inside the vm sandbox's own realm — deepStrictEqual fails purely on
  // prototype identity against a literal from this (outer) realm otherwise,
  // the same cross-realm trap documented elsewhere in this file for arrays.
  assert.deepEqual(Object.assign({}, lookup['stage-1']), { pipelineName: 'Cold Calling', stageName: 'Qualification Call Not Taken', disposition: 'No-show' });
  assert.deepEqual(Object.assign({}, lookup['stage-2']), { pipelineName: 'Cold Calling', stageName: 'Closed Won', disposition: 'Sold' });
  assert.deepEqual(Object.assign({}, lookup['stage-3']), { pipelineName: 'ICONS Podcast', stageName: 'No Show', disposition: 'No-show' });
});

test('describeGhlProbeResult_ distinguishes a missing SCOPE from a wrong ENDPOINT — the whole point of the discovery probe', () => {
  // A 401 means the Private Integration token lacks a scope; the feature may
  // well exist. A 404 means the path guess was wrong. Conflating the two is
  // how you wrongly conclude "GHL doesn't have workflows".
  const unauthorized = gas.describeGhlProbeResult_({ status: 401, body: 'no access' });
  assert.ok(/401/.test(unauthorized) && /scope/.test(unauthorized));
  const missing = gas.describeGhlProbeResult_({ status: 404, body: 'not found' });
  assert.ok(/404/.test(missing) && /path is wrong/.test(missing));
  assert.ok(/403/.test(gas.describeGhlProbeResult_({ status: 403, body: 'nope' })));
});

test('describeGhlProbeResult_ counts the records in whichever key holds the list', () => {
  const out = gas.describeGhlProbeResult_({
    status: 200,
    json: { workflows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], traceId: 'x' },
    body: '{"workflows":[...]}'
  });
  assert.ok(/HTTP 200/.test(out));
  assert.ok(/3 record\(s\) under "workflows"/.test(out), 'the record count is the headline number: ' + out);
  assert.ok(/keys=\[workflows, traceId\]/.test(out), 'top-level keys are shown so an unexpected shape is visible');
});

test('describeGhlProbeResult_ handles a 200 with no list and a junk response without throwing', () => {
  const noList = gas.describeGhlProbeResult_({ status: 200, json: { location: { id: 'x' } }, body: '{}' });
  assert.ok(/HTTP 200/.test(noList));
  assert.ok(!/record\(s\)/.test(noList), 'nothing to count when no key holds an array');
  assert.equal(gas.describeGhlProbeResult_(null), 'no response');
  assert.equal(gas.describeGhlProbeResult_(undefined), 'no response');
});

test('describeGhlProbeResult_ gives a single-object response (no array key) a much longer preview than a list response, so a deeply-nested field is not silently cut off (real bug found live 11/09/2026: the Location detail probe — the one that answers the Twilio-vs-LC-Phone question — was cut off at 300 characters, well before reaching any settings field)', () => {
  const longBody = '{"location":{"id":"x","name":"y",' + 'z'.repeat(1000) + '"phone_provider":"twilio"}}';
  const out = gas.describeGhlProbeResult_({ status: 200, json: { location: { id: 'x' } }, body: longBody });
  assert.ok(out.length > 500, 'a single-object response must get a much longer preview than the old flat 300 chars: got length ' + out.length);
});

test('describeGhlPhoneProviderMentions_ finds a Twilio/LC-Phone mention anywhere in the raw body, case-insensitively, regardless of where it sits in the JSON', () => {
  assert.equal(gas.describeGhlPhoneProviderMentions_('{"settings":{"smsProvider":"Twilio"}}'),
    'PHONE PROVIDER MENTIONED: twilio');
  assert.equal(gas.describeGhlPhoneProviderMentions_('{"provider":"LC Phone"}'),
    'PHONE PROVIDER MENTIONED: lc phone');
  assert.equal(gas.describeGhlPhoneProviderMentions_('{"id":"x","name":"Icons of Real Estate"}'), null,
    'no mention at all must return null, not an empty/misleading string');
  assert.equal(gas.describeGhlPhoneProviderMentions_(''), null);
  assert.equal(gas.describeGhlPhoneProviderMentions_(null), null);
});

test('describeGhlProbeResult_ surfaces the phone-provider line for a single-object response, but never for a list response (a list of workflows mentioning "twilio" in a workflow NAME would be a false positive to flag as the account-level answer)', () => {
  const withMention = gas.describeGhlProbeResult_({
    status: 200, json: { location: { id: 'x' } }, body: '{"location":{"phoneProvider":"twilio"}}'
  });
  assert.ok(/PHONE PROVIDER MENTIONED: twilio/.test(withMention));

  const listWithMention = gas.describeGhlProbeResult_({
    status: 200, json: { workflows: [{ id: 'a' }] }, body: '{"workflows":[{"name":"Twilio SMS reminder"}]}'
  });
  assert.ok(!/PHONE PROVIDER MENTIONED/.test(listWithMention),
    'a list response must never surface this line, even if a record happens to mention the word');
});

test('previewGhlAccountDiscovery_\'s Form submissions probe sends an explicit, valid limit param (real bug found live 11/09/2026: GHL 422\'d with "limit must not be greater than 100" / "limit must be a number" when this endpoint got no limit at all, unlike every other list endpoint probed here)', () => {
  const calledPaths = [];
  const originalGet = gas.ghlApiGet_;
  const originalCheckSetup = gas.ghlCheckSetup_;
  gas.ghlApiGet_ = (path) => { calledPaths.push(path); return { status: 200, json: {}, body: '{}' }; };
  gas.ghlCheckSetup_ = () => 'loc-1';
  try {
    gas.previewGhlAccountDiscovery_();
    const submissionsCall = calledPaths.find((p) => p.indexOf('/forms/submissions') !== -1);
    assert.ok(submissionsCall, 'the Form submissions probe must actually run');
    assert.ok(/limit=\d+/.test(submissionsCall), 'must send an explicit numeric limit: ' + submissionsCall);
    assert.ok(!/limit=(&|$)/.test(submissionsCall), 'limit must not be present-but-blank either');
  } finally {
    gas.ghlApiGet_ = originalGet;
    gas.ghlCheckSetup_ = originalCheckSetup;
  }
});

test('ghlTimestampToIso_ normalizes BOTH of GHL\'s timestamp formats (real bug: raw epoch ms sitting in the live "GHL Stage Triage" tab)', () => {
  // Confirmed from the live sheet 09/09/2026: Last GHL Activity holds raw
  // values like 1787216916228 next to proper ISO strings, because notes come
  // back ISO and conversation dates come back epoch ms.
  assert.equal(gas.ghlTimestampToIso_(1787216916228), '2026-08-20T09:08:36.228Z');
  assert.equal(gas.ghlTimestampToIso_('1787216916228'), '2026-08-20T09:08:36.228Z');
  assert.equal(gas.ghlTimestampToIso_('2026-09-05T05:54:10.990Z'), '2026-09-05T05:54:10.990Z');
  // epoch SECONDS (10 digits) must not be read as milliseconds — that would
  // land in 1970 and silently look like the oldest activity on the account.
  assert.equal(gas.ghlTimestampToIso_(1787216916).slice(0, 4), '2026');
  ['', null, undefined, 'not a date'].forEach((v) => {
    assert.equal(gas.ghlTimestampToIso_(v), '', JSON.stringify(v) + ' has no usable timestamp');
  });
});

test('summarizeGhlMessages_ buckets by GHL\'s own channel values and splits inbound vs outbound', () => {
  const out = gas.summarizeGhlMessages_([
    { messageType: 'TYPE_SMS', direction: 'outbound', body: 'hi', dateAdded: 1787216916228 },
    { messageType: 'TYPE_SMS', direction: 'inbound', body: 'hey', dateAdded: 1787216916229 },
    { messageType: 'TYPE_CALL', direction: 'outbound', recordingUrl: 'https://x/rec.mp3', dateAdded: 1787216916230 },
    { messageType: 'TYPE_EMAIL', direction: 'outbound', body: 'hello', dateAdded: 1787216916231 }
  ]);
  assert.equal(out.totalMessages, 4);
  assert.deepEqual(Array.prototype.slice.call(out.channels), ['TYPE_CALL', 'TYPE_EMAIL', 'TYPE_SMS']);
  assert.equal(out.byChannel['TYPE_SMS'].total, 2);
  assert.equal(out.byChannel['TYPE_SMS'].inbound, 1);
  assert.equal(out.byChannel['TYPE_SMS'].outbound, 1);
  // Recordings are counted separately: they are the one thing we could not
  // rebuild without owning telephony.
  assert.equal(out.withRecordingOrAttachment, 1);
  assert.equal(out.withBody, 3);
});

test('summarizeGhlMessages_ reports the real date range and the union of field names (that union is the schema to model)', () => {
  const out = gas.summarizeGhlMessages_([
    { messageType: 'TYPE_SMS', direction: 'inbound', dateAdded: 1764956344308, body: 'older' },
    { messageType: 'TYPE_SMS', direction: 'inbound', dateAdded: 1787216916228, conversationId: 'c1' }
  ]);
  assert.equal(out.earliest, '2025-12-05T17:39:04.308Z');
  assert.equal(out.latest, '2026-08-20T09:08:36.228Z');
  assert.deepEqual(Array.prototype.slice.call(out.fieldNames), ['body', 'conversationId', 'dateAdded', 'direction', 'messageType']);
});

test('summarizeGhlMessages_ survives an empty/garbage payload rather than throwing mid-audit', () => {
  [[], null, undefined].forEach((v) => {
    const out = gas.summarizeGhlMessages_(v);
    assert.equal(out.totalMessages, 0);
    assert.deepEqual(Array.prototype.slice.call(out.channels), []);
    assert.equal(out.earliest, '');
  });
  // A non-object entry must be skipped, not counted or crashed on.
  const mixed = gas.summarizeGhlMessages_([null, 'nope', { messageType: 'TYPE_SMS', direction: 'inbound' }]);
  assert.equal(mixed.byChannel['TYPE_SMS'].total, 1);
});

test('summarizeGhlMessages_ falls back to `type` and records an unknown channel rather than dropping the message', () => {
  const out = gas.summarizeGhlMessages_([
    { type: 'TYPE_VOICEMAIL', direction: 'inbound' },
    { direction: 'outbound' }
  ]);
  assert.equal(out.byChannel['TYPE_VOICEMAIL'].total, 1);
  assert.equal(out.byChannel['UNKNOWN'].total, 1, 'an unlabelled message is still counted, under UNKNOWN');
  assert.equal(out.totalMessages, 2);
});

test('contactNameLooksLikeQuery_ rejects the real "Desiree Doggett" noise (28/08/2026 live run: GHL returned 5 contacts with zero relation to the queried name)', () => {
  const noise = [
    { name: 'justin stamper' },
    { name: 'avery carl' },
    { name: 'carlos beruff' },
    { name: 'patrick neal' },
    { name: 'bob turner' }
  ];
  noise.forEach((c) => {
    assert.equal(gas.contactNameLooksLikeQuery_(c, 'Desiree Doggett'), false, c.name + ' shares no token with Desiree Doggett');
  });
});

test('contactNameLooksLikeQuery_ accepts a real match by shared name token, first/last order or partial overlap', () => {
  assert.equal(gas.contactNameLooksLikeQuery_({ name: 'Anthony Camperi' }, 'Anthony Camperi'), true);
  assert.equal(gas.contactNameLooksLikeQuery_({ firstName: 'Roger', lastName: 'Hance' }, 'Roger Hance'), true);
  // "Danny Rodriguez - 2nd" (a real cleaned Prospect Name) still matches the plain contact name.
  assert.equal(gas.contactNameLooksLikeQuery_({ name: 'Danny Rodriguez' }, 'Danny Rodriguez - 2nd'), true);
});

test('contactNameLooksLikeQuery_ does not let a short token like "2nd" -> "nd" count as a match on its own', () => {
  // "nd" is 2 letters; the >= 3 length floor exists specifically so a
  // coincidental short-token collision can't manufacture a false match.
  assert.equal(gas.contactNameLooksLikeQuery_({ name: 'Andy Nixon' }, 'Danny Rodriguez - 2nd'), false);
});

test('contactNameLooksLikeQuery_ returns false, not throws, on missing/blank name fields', () => {
  assert.equal(gas.contactNameLooksLikeQuery_({}, 'Desiree Doggett'), false);
  assert.equal(gas.contactNameLooksLikeQuery_({ name: 'Desiree Doggett' }, ''), false);
});

function fakeSalesCallLogSheet(dataRows) {
  const headerRow = gas.SALES_CALL_LOG_HEADERS.slice();
  return {
    getLastRow: () => dataRows.length + 1,
    getRange: (row) => {
      if (row === 1) return { getValues: () => [headerRow] };
      return { getValues: () => dataRows };
    }
  };
}

function fakeSalesCallLogRow(overrides) {
  const row = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  Object.keys(overrides).forEach((header) => {
    row[gas.SALES_CALL_LOG_HEADERS.indexOf(header)] = overrides[header];
  });
  return row;
}

test('sampleSalesCallLogRows_ caps the sample at N rows PER REP, not N rows total (real risk: sheet order could otherwise hand back only one rep and tell us nothing about the others)', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Sean Call A', Rep: 'Sean', 'Call Date': '01/07/2026' }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Sean Call B', Rep: 'Sean', 'Call Date': '02/07/2026' }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Sean Call C', Rep: 'Sean', 'Call Date': '03/07/2026' }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Bens Call A', Rep: 'Bens', 'Call Date': '01/07/2026' })
  ];
  const sheet = fakeSalesCallLogSheet(dataRows);
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
  try {
    const sample = gas.sampleSalesCallLogRows_(2);
    assert.equal(sample.filter((r) => r.rep === 'Sean').length, 2, 'Sean has 3 real rows but the cap is 2 per rep');
    assert.equal(sample.filter((r) => r.rep === 'Bens').length, 1, 'Bens only has 1 real row, cap does not pad it out');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

test('sampleSalesCallLogRows_ skips rows with a blank Rep rather than crashing or grouping them together', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'No Rep Row', Rep: '', 'Call Date': '01/07/2026' }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Real Row', Rep: 'Joana', 'Call Date': '01/07/2026' })
  ];
  const sheet = fakeSalesCallLogSheet(dataRows);
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
  try {
    const sample = gas.sampleSalesCallLogRows_(5);
    assert.equal(sample.length, 1);
    assert.equal(sample[0].prospectName, 'Real Row');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

/**
 * Fake sheet supporting BOTH calling conventions rescoreAllCalls_ needs:
 * getRange(1, 1, 1, N) / getRange(2, 1, lastRow-1, N) — bulk 4-arg reads
 * (header check, then the full data block, same as getValidatedColumnMap_
 * and rescoreAllCalls_'s own initial read) — and getRange(row, col).setValue(v)
 * — single-cell writes (writeScoreToRow_'s only calling pattern). Discriminated
 * by whether numCols is passed, not by row number, since both patterns use
 * row >= 2.
 */
function fakeSalesCallLogSheetForRescore(dataRows) {
  const headerRow = gas.SALES_CALL_LOG_HEADERS.slice();
  const cells = {};
  return {
    getLastRow: () => dataRows.length + 1,
    getRange: (row, col, numRows, numCols) => {
      if (numCols !== undefined) {
        if (row === 1) return { getValues: () => [headerRow] };
        return { getValues: () => dataRows };
      }
      return { setValue(v) { cells[row + ':' + col] = v; return this; } };
    },
    _cells: cells
  };
}

test('rescoreAllCalls_ re-scores an already-scored row under the current rubric, skips a row Kris has manually reviewed, and skips a row already at the current Rubric Version (resumability) — 29/08/2026, Kris\'s retroactive-review ask', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });

  const dataRows = [
    fakeSalesCallLogRow({
      'Prospect Name': 'Needs Rescore', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    }),
    fakeSalesCallLogRow({
      'Prospect Name': 'Kris Already Judged This', Rep: 'Sean', 'Call Type': 'Sales Call', 'Match Method': 'fallback_heuristic',
      'Transcript URL': 'https://docs.google.com/document/d/1BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/edit',
      'Call Quality Score': 4, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': 'Yes'
    }),
    fakeSalesCallLogRow({
      'Prospect Name': 'Already Current', Rep: 'Bens', 'Call Type': 'QC', 'Match Method': 'fallback_heuristic',
      'Transcript URL': 'https://docs.google.com/document/d/1CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC/edit',
      'Call Quality Score': 5, 'Rubric Version': gas.RUBRIC_VERSION, 'Kris Manual Review Verdict': ''
    })
  ];
  const sheet = fakeSalesCallLogSheetForRescore(dataRows);

  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalScoreQc = gas.scoreQcTranscript_;
  const originalScoreShared = gas.scoreTranscript_;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.DriveApp = { getFileById: () => ({ getName: () => 'Fake Prospect.mp4 — Transcript', getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => FAKE_TRANSCRIPT_ }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };

    const scoredVariants = [];
    gas.scoreQcTranscript_ = (ctx) => {
      scoredVariants.push({ variant: 'qc', prospectName: ctx.prospectName });
      return {
        reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
        flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true },
        framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
        delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
        primary_failure_mode: 'none', root_cause_if_no_booking: 'N/A', manual_review_recommended: false, severity: 1,
        feedback_summary: 'rescored'
      };
    };
    gas.scoreTranscript_ = (ctx) => {
      scoredVariants.push({ variant: 'shared', prospectName: ctx.prospectName });
      throw new Error('should not be called — row 2 has a manual verdict and must be skipped entirely');
    };

    gas.rescoreAllCalls_(false);

    // dataRows[0] "Needs Rescore" is sheet row 2 (values[r] -> row r+2); "Kris Already
    // Judged This" is row 3; "Already Current" is row 4.
    assert.deepEqual(scoredVariants, [{ variant: 'qc', prospectName: 'Needs Rescore' }],
      'only the row needing a rescore should ever reach a judge function — Kris-reviewed and already-current rows must never call the model');
    assert.equal(sheet._cells['2:' + col['Rubric Version']], gas.RUBRIC_VERSION);
    assert.equal(sheet._cells['2:' + col['Call Quality Score']], 4);
    assert.equal(sheet._cells['2:' + col['Flag: Delivery Effective']], true);

    // Row 3 (Kris-reviewed) and row 4 (already current) must be completely untouched — no cell written for either.
    assert.equal(Object.keys(sheet._cells).some((k) => k.startsWith('3:')), false, 'the Kris-reviewed row must never be written to');
    assert.equal(Object.keys(sheet._cells).some((k) => k.startsWith('4:')), false, 'the already-current row must never be written to');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.scoreQcTranscript_ = originalScoreQc;
    gas.scoreTranscript_ = originalScoreShared;
  }
});

test('rescoreAllCalls_\'s dry-run preview (previewRescoreAllCalls) calls no judge function and writes nothing', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const dataRows = [
    fakeSalesCallLogRow({
      'Prospect Name': 'Would Be Rescored', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    })
  ];
  const sheet = fakeSalesCallLogSheetForRescore(dataRows);

  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalScoreQc = gas.scoreQcTranscript_;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.DriveApp = { getFileById: () => ({ getName: () => 'Fake Prospect.mp4 — Transcript', getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => FAKE_TRANSCRIPT_ }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.scoreQcTranscript_ = () => { throw new Error('previewRescoreAllCalls must never call a judge function'); };

    gas.previewRescoreAllCalls();

    assert.deepEqual(sheet._cells, {}, 'dry run must write nothing at all');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.scoreQcTranscript_ = originalScoreQc;
  }
});

test('rescoreAllCalls_ (live, not dry-run) logs an upfront scope count and a per-row progress line, not just failures (real bug, 29/08/2026: Kris reported "running 2 minutes with nothing written" — a live pass logged NOTHING for a successfully-scored row, indistinguishable from a hang)', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const dataRows = [
    fakeSalesCallLogRow({
      'Prospect Name': 'Logged Live', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    })
  ];
  const sheet = fakeSalesCallLogSheetForRescore(dataRows);

  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalScoreQc = gas.scoreQcTranscript_;
  const originalLog = gas.Logger.log;
  const lines = [];
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.DriveApp = { getFileById: () => ({ getName: () => 'Fake Prospect.mp4 — Transcript', getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => FAKE_TRANSCRIPT_ }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.Logger.log = (msg) => lines.push(msg);
    gas.scoreQcTranscript_ = () => ({
      reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
      flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true },
      framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
      delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
      primary_failure_mode: 'none', root_cause_if_no_booking: 'N/A', manual_review_recommended: false, severity: 1,
      feedback_summary: 'rescored'
    });

    gas.rescoreAllCalls_(false);

    const joined = lines.join('\n');
    assert.match(joined, /1 row\(s\) out of 1 row\(s\) in the sheet need a rescore this pass/, 'must log the real scope up front, before any model call');
    assert.match(joined, /Queued: 1\. row 2 Logged Live \(Joana, QC/,
      'must list which row(s) are queued up front, not just a count (08/09/2026: "logging needs to be better")');
    assert.match(joined, /\[1\/1\] Rescoring row 2 \(Logged Live,.*calling the model now/,
      'must log BEFORE the model call, since that call can run minutes with nothing else in between');
    assert.match(joined, /\[1\/1\] Done: row 2 \(Logged Live\).*score 3 -> 4/, 'must log each row as it completes, not stay silent until the end');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.scoreQcTranscript_ = originalScoreQc;
    gas.Logger.log = originalLog;
  }
});

test('rescoreAllCalls_ groups eligible rows by rubric variant before scoring, not raw sheet order (real cost bug, 30/08/2026: Moonshot\'s Kimi API caches on a shared prompt PREFIX across consecutive calls — sheet order interleaves reps/Call Types, so almost every call was a full-price cache miss even though many rows share the same system prompt)', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  // Sheet order deliberately interleaves variants: qc, sean, qc, sean — a
  // cache-hostile order if processed as-is.
  const dataRows = [
    fakeSalesCallLogRow({
      'Prospect Name': 'QC One', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    }),
    fakeSalesCallLogRow({
      'Prospect Name': 'Sean One', Rep: 'Sean', 'Call Type': 'Sales Call', 'Match Method': 'fallback_heuristic',
      'Transcript URL': 'https://docs.google.com/document/d/1GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    }),
    fakeSalesCallLogRow({
      'Prospect Name': 'QC Two', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    }),
    fakeSalesCallLogRow({
      'Prospect Name': 'Sean Two', Rep: 'Sean', 'Call Type': 'Sales Call', 'Match Method': 'fallback_heuristic',
      'Transcript URL': 'https://docs.google.com/document/d/1IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    })
  ];
  const sheet = fakeSalesCallLogSheetForRescore(dataRows);

  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalScoreQc = gas.scoreQcTranscript_;
  const originalScoreSean = gas.scoreSeanTranscript_;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.DriveApp = { getFileById: () => ({ getName: () => 'Fake Prospect.mp4 — Transcript', getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => FAKE_TRANSCRIPT_ }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };

    const order = [];
    const fakeResult = (variantLabel) => {
      order.push(variantLabel);
      return {
        reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
        flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true, captured_leads_goals: true, tied_framework_to_goals: true, booked_second_call_with_tomas: true },
        framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
        delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
        primary_failure_mode: 'none', root_cause_if_no_booking: 'N/A', root_cause_if_no_sale: 'N/A',
        manual_review_recommended: false, severity: 1, feedback_summary: 'rescored'
      };
    };
    gas.scoreQcTranscript_ = () => fakeResult('qc');
    gas.scoreSeanTranscript_ = () => fakeResult('sean');

    gas.rescoreAllCalls_(false);

    assert.deepEqual(order, ['qc', 'qc', 'sean', 'sean'],
      'both qc calls must run back-to-back, then both sean calls — not interleaved as they appear in the sheet');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.scoreQcTranscript_ = originalScoreQc;
    gas.scoreSeanTranscript_ = originalScoreSean;
  }
});

test('rescoreAllCalls_ returns true when this pass found eligible rows, and false once nothing is left eligible (real cadence bug, 31/08/2026: Kimi calls run ~2.5min each so a manual 5-minute-budget run only clears ~2 of 461 rows — this return value is what lets a recurring trigger know whether to keep firing)', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalScoreQc = gas.scoreQcTranscript_;
  try {
    gas.DriveApp = { getFileById: () => ({ getName: () => 'Fake Prospect.mp4 — Transcript', getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => FAKE_TRANSCRIPT_ }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.scoreQcTranscript_ = () => ({
      reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
      flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true },
      framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
      delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
      primary_failure_mode: 'none', root_cause_if_no_booking: 'N/A', manual_review_recommended: false, severity: 1,
      feedback_summary: 'rescored'
    });

    const eligibleRow = [fakeSalesCallLogRow({
      'Prospect Name': 'Still Eligible', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    })];
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheetForRescore(eligibleRow) }) };
    assert.equal(gas.rescoreAllCalls_(false), true, 'a pass that found eligible rows must report there was work');

    const noneEligibleRow = [fakeSalesCallLogRow({
      'Prospect Name': 'Already Current', Rep: 'Bens', 'Call Type': 'QC', 'Match Method': 'fallback_heuristic',
      'Transcript URL': 'https://docs.google.com/document/d/1KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK/edit',
      'Call Quality Score': 5, 'Rubric Version': gas.RUBRIC_VERSION, 'Kris Manual Review Verdict': ''
    })];
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheetForRescore(noneEligibleRow) }) };
    assert.equal(gas.rescoreAllCalls_(false), false, 'a pass that found nothing eligible must report there was no more work');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.scoreQcTranscript_ = originalScoreQc;
  }
});

function fakeScriptAppTriggers_(initialHandlerNames) {
  const triggers = initialHandlerNames.map((name) => ({ getHandlerFunction: () => name }));
  // Chainable builder supporting every calling convention used in this codebase:
  // .timeBased().everyMinutes(n).create() (rescore/legacy-backfill triggers),
  // .timeBased().everyHours(n).create() (reinstallHourlyTrigger_ — Phase 2/9),
  // .timeBased().everyDays(1).atHour(h).inTimezone(tz).create() (Phase 1/7 daily triggers), and
  // .timeBased().onWeekDay(d).atHour(h).inTimezone(tz).create() (Phase 1/5 weekly triggers).
  const makeBuilder = (fnName) => {
    const builder = {
      everyMinutes: () => builder,
      everyHours: () => builder,
      everyDays: () => builder,
      onWeekDay: () => builder,
      atHour: () => builder,
      inTimezone: () => builder,
      create: () => { const t = { getHandlerFunction: () => fnName }; triggers.push(t); return t; }
    };
    return builder;
  };
  return {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: (t) => { const idx = triggers.indexOf(t); if (idx !== -1) triggers.splice(idx, 1); },
    newTrigger: (fnName) => ({ timeBased: () => makeBuilder(fnName) }),
    // WeekDay is a plain enum on the real ScriptApp — installPlaybookReviewTrigger
    // and installWeeklyTrainingSummaryTrigger both reference ScriptApp.WeekDay.TUESDAY.
    WeekDay: { SUNDAY: 'SUNDAY', MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY',
      THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY' },
    _triggers: triggers
  };
}

test('installRescoreAllCallsTrigger removes any prior copy of its own trigger before installing a fresh one (idempotent, same pattern as installLegacyBackfillTrigger — a second accidental install must not stack duplicate 10-minute triggers)', () => {
  const originalScriptApp = gas.ScriptApp;
  try {
    gas.ScriptApp = fakeScriptAppTriggers_(['runRescoreAllCallsViaTrigger_', 'someOtherHandler_']);
    gas.installRescoreAllCallsTrigger();
    const handlerNames = gas.ScriptApp._triggers.map((t) => t.getHandlerFunction());
    assert.equal(handlerNames.filter((h) => h === 'runRescoreAllCallsViaTrigger_').length, 1, 'must never have more than one of its own trigger installed');
    assert.ok(handlerNames.indexOf('someOtherHandler_') !== -1, 'must not touch unrelated triggers');
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

test('removeRescoreAllCallsTrigger_ removes only its own handler\'s trigger(s), leaving unrelated triggers alone', () => {
  const originalScriptApp = gas.ScriptApp;
  try {
    gas.ScriptApp = fakeScriptAppTriggers_(['runRescoreAllCallsViaTrigger_', 'someOtherHandler_']);
    gas.removeRescoreAllCallsTrigger_();
    const handlerNames = gas.ScriptApp._triggers.map((t) => t.getHandlerFunction());
    assert.deepEqual(handlerNames, ['someOtherHandler_']);
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

test('runRescoreAllCallsViaTrigger_ removes the recurring trigger once a pass finds nothing left eligible, and leaves it running while there\'s still work (so it can run unattended across the ~461-row backfill instead of Kris manually re-running it hundreds of times)', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalRescoreAllCalls_ = gas.rescoreAllCalls_;
  try {
    gas.ScriptApp = fakeScriptAppTriggers_(['runRescoreAllCallsViaTrigger_']);
    gas.rescoreAllCalls_ = () => true; // still more work
    gas.runRescoreAllCallsViaTrigger_();
    assert.equal(gas.ScriptApp._triggers.length, 1, 'trigger must stay installed while there is still more work');

    gas.rescoreAllCalls_ = () => false; // done
    gas.runRescoreAllCallsViaTrigger_();
    assert.equal(gas.ScriptApp._triggers.length, 0, 'trigger must be removed once a pass finds nothing left eligible');
  } finally {
    gas.ScriptApp = originalScriptApp;
    gas.rescoreAllCalls_ = originalRescoreAllCalls_;
  }
});

test('listAllTriggers logs the total against the 20-trigger project cap and flags any handler with more than one copy installed (real bug, 31/08/2026: installRescoreAllCallsTrigger threw "This script has too many triggers" — this diagnostic is how Kris finds out what to remove instead of guessing)', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalLog = gas.Logger.log;
  const lines = [];
  try {
    gas.ScriptApp = fakeScriptAppTriggers_(['runDailyComplianceCheck', 'runAllLegacyBackfills_', 'runAllLegacyBackfills_', 'runWeeklyScorecard']);
    gas.Logger.log = (msg) => lines.push(msg);

    gas.listAllTriggers();

    const joined = lines.join('\n');
    assert.match(joined, /4 of the 20-trigger project limit in use/, 'must report the real count against the real cap');
    assert.match(joined, /2x {2}runAllLegacyBackfills_ {2}<-- more than one copy, likely safe to dedupe/, 'must flag the handler with more than one trigger installed');
    assert.ok(joined.indexOf('1x  runDailyComplianceCheck') !== -1 && joined.indexOf('runDailyComplianceCheck  <--') === -1, 'a handler with exactly one trigger must not be flagged');
  } finally {
    gas.ScriptApp = originalScriptApp;
    gas.Logger.log = originalLog;
  }
});

test('resolveBestDispositionForOpportunities_ returns the single disposition implied across a contact\'s opportunities, real example: Meriam Hansen\'s 3 opportunities (28/08/2026 live run) all imply nothing yet, not a conflict', () => {
  const stageLookup = {
    'podcast-booked': { pipelineName: 'ICONS Podcast', stageName: 'Podcast Booked On Calendar', disposition: null },
    'sc-booked': { pipelineName: 'SALES CALL pipeline', stageName: 'Sales Call - Booked', disposition: null },
    'qc-booked': { pipelineName: 'Cold Calling 2', stageName: 'Qualification Call Booked', disposition: null }
  };
  const result = gas.resolveBestDispositionForOpportunities_(
    [{ pipelineStageId: 'podcast-booked' }, { pipelineStageId: 'sc-booked' }, { pipelineStageId: 'qc-booked' }],
    stageLookup
  );
  assert.deepEqual(Object.assign({}, result), { disposition: null, conflict: false });
});

test('resolveBestDispositionForOpportunities_ returns the disposition when exactly one opportunity resolves to a real one', () => {
  const stageLookup = { 'closed-won': { pipelineName: 'SALES CALL pipeline', stageName: 'Closed Won', disposition: 'Sold' } };
  const result = gas.resolveBestDispositionForOpportunities_([{ pipelineStageId: 'closed-won' }], stageLookup);
  assert.deepEqual(Object.assign({}, result), { disposition: 'Sold', conflict: false });
});

test('resolveBestDispositionForOpportunities_ flags a conflict rather than guessing when two opportunities imply DIFFERENT real dispositions', () => {
  const stageLookup = {
    'closed-won': { pipelineName: 'SALES CALL pipeline', stageName: 'Closed Won', disposition: 'Sold' },
    'no-show': { pipelineName: 'Cold Calling 2', stageName: 'No Show', disposition: 'No-show' }
  };
  const result = gas.resolveBestDispositionForOpportunities_(
    [{ pipelineStageId: 'closed-won' }, { pipelineStageId: 'no-show' }],
    stageLookup
  );
  assert.equal(result.conflict, true);
  assert.equal(result.disposition, null);
});

// ---------------------------------------------------------------------------
// computeGhlSyncFixes_ (Phase9_GhlSync.gs) — the Prospect Email / Outcome
// Disposition backfill at the heart of previewGhlSync_/syncGhlEmailAndDisposition_.
// ---------------------------------------------------------------------------

function withMockedGhlSync_(mocks, fn) {
  const originals = {
    SpreadsheetApp: gas.SpreadsheetApp,
    Utilities: gas.Utilities,
    ghlSearchContactByName_: gas.ghlSearchContactByName_,
    ghlListOpportunitiesForContact_: gas.ghlListOpportunitiesForContact_
  };
  gas.Utilities = { sleep: () => {}, formatDate: realFormatDate };
  Object.assign(gas, mocks);
  try {
    return fn();
  } finally {
    Object.assign(gas, originals);
  }
}

test('computeGhlSyncFixes_ skips a row that already has BOTH Prospect Email and Outcome Disposition filled, with no GHL call at all', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Already Done', Rep: 'Sean', 'Prospect Email': 'done@x.com', 'Outcome Disposition': 'Sold' })
  ];
  let searchCalls = 0;
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => { searchCalls++; return { ok: true, contacts: [] }; }
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(searchCalls, 0, 'a fully-filled row must never trigger a GHL search');
  assert.equal(result.stats.skippedAlreadyFilled, 1);
  assert.equal(result.fixes.length, 0);
});

test('computeGhlSyncFixes_ backfills a blank Prospect Email from a single confident GHL match', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Anthony Camperi', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': 'Sold' })
  ];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Anthony Camperi', email: 'camperirealestate@outlook.com' }] })
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(result.fixes.length, 1);
  assert.equal(result.fixes[0].newEmail, 'camperirealestate@outlook.com');
  assert.equal(result.fixes[0].newDisposition, undefined, 'Outcome Disposition was already filled, must not be touched');
  assert.equal(result.stats.emailFixes, 1);
});

test('computeGhlSyncFixes_ fills a blank Outcome Disposition from the matched contact\'s single resolved opportunity', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Nicole Freed', Rep: 'Bens', 'Prospect Email': 'nicole.freed@yahoo.com', 'Outcome Disposition': '' })
  ];
  const stageLookup = { 'closed-won': { pipelineName: 'SALES CALL pipeline', stageName: 'Closed Won', disposition: 'Sold' } };
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Nicole Freed', email: 'nicole.freed@yahoo.com' }] }),
    ghlListOpportunitiesForContact_: () => ({ ok: true, opportunities: [{ pipelineStageId: 'closed-won' }] })
  }, () => gas.computeGhlSyncFixes_('loc-1', stageLookup));
  assert.equal(result.fixes.length, 1);
  assert.equal(result.fixes[0].newDisposition, 'Sold');
  assert.equal(result.fixes[0].newEmail, undefined, 'Prospect Email was already filled, must not be touched');
  assert.equal(result.stats.dispositionFixes, 1);
});

test('computeGhlSyncFixes_ reports the real "Desiree Doggett" case as no-match, not ambiguous, once garbage candidates are filtered by name', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Desiree Doggett', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '' })
  ];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({
      ok: true,
      contacts: [
        { name: 'justin stamper' }, { name: 'avery carl' }, { name: 'carlos beruff' },
        { name: 'patrick neal' }, { name: 'bob turner' }
      ]
    })
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(result.stats.noMatch, 1);
  assert.equal(result.stats.ambiguous, 0);
  assert.equal(result.fixes.length, 0);
});

test('computeGhlSyncFixes_ leaves Outcome Disposition blank and counts a conflict, rather than guessing, when opportunities disagree', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Conflicted Contact', Rep: 'Sean', 'Prospect Email': 'x@x.com', 'Outcome Disposition': '' })
  ];
  const stageLookup = {
    'closed-won': { pipelineName: 'SALES CALL pipeline', stageName: 'Closed Won', disposition: 'Sold' },
    'no-show': { pipelineName: 'Cold Calling 2', stageName: 'No Show', disposition: 'No-show' }
  };
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Conflicted Contact' }] }),
    ghlListOpportunitiesForContact_: () => ({ ok: true, opportunities: [{ pipelineStageId: 'closed-won' }, { pipelineStageId: 'no-show' }] })
  }, () => gas.computeGhlSyncFixes_('loc-1', stageLookup));
  assert.equal(result.fixes.length, 0);
  assert.equal(result.stats.dispositionConflicts, 1);
});

test('computeGhlSyncFixes_ stops at the time budget and reports a partial scan, rather than risking a hard Apps Script timeout', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Row One', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '' }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Row Two', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '' })
  ];
  const originalBudget = gas.GHL_SYNC_TIME_BUDGET_MS_;
  gas.GHL_SYNC_TIME_BUDGET_MS_ = -1; // already "expired" before the loop even starts
  let searchCalls = 0;
  try {
    const result = withMockedGhlSync_({
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
      ghlSearchContactByName_: () => { searchCalls++; return { ok: true, contacts: [] }; }
    }, () => gas.computeGhlSyncFixes_('loc-1', {}));
    assert.equal(result.truncated, true);
    assert.equal(searchCalls, 0, 'the budget check must run before the first GHL call, not after');
  } finally {
    gas.GHL_SYNC_TIME_BUDGET_MS_ = originalBudget;
  }
});

// ---------------------------------------------------------------------------
// GHL Match Status stamping — real bug found live 11/09/2026 (Kris ran
// syncGhlEmailAndDisposition() many times in a row, each scanning hundreds
// of rows and finding zero fixes): an ambiguous/no-match/nothing-to-
// backfill row was left completely blank forever, so every run re-spent
// API calls re-scanning the exact same dead rows in the same sheet order,
// and could burn the whole time budget on that cluster without ever
// reaching fresh rows further down.
// ---------------------------------------------------------------------------

test('computeGhlSyncFixes_ stamps GHL Match Status for a no-match row, so a future run skips it instead of re-querying GHL forever', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Nobody Found', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '' })
  ];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [] })
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(result.statusStamps.length, 1);
  assert.equal(result.statusStamps[0].row, 2);
  assert.ok(result.statusStamps[0].status.indexOf('No GHL match') === 0);
});

test('computeGhlSyncFixes_ stamps GHL Match Status for an ambiguous row, naming the candidate count', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Nicole Freed', Rep: 'Bens', 'Prospect Email': '', 'Outcome Disposition': '' })
  ];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Nicole Freed' }, { id: 'c2', name: 'Nicole Freed' }] })
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(result.statusStamps.length, 1);
  assert.ok(result.statusStamps[0].status.indexOf('Ambiguous') === 0);
  assert.ok(result.statusStamps[0].status.indexOf('2 candidates') !== -1);
});

test('computeGhlSyncFixes_ stamps GHL Match Status for a confident match with nothing left to backfill (contact has no email, no opportunities)', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Empty Contact', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '' })
  ];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Empty Contact', email: '' }] }),
    ghlListOpportunitiesForContact_: () => ({ ok: true, opportunities: [] })
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(result.fixes.length, 0, 'nothing was actually fixed this run');
  assert.equal(result.statusStamps.length, 1, 'but the row must still be stamped so it is not re-scanned forever');
  assert.ok(result.statusStamps[0].status.indexOf('Matched') === 0);
  assert.ok(result.statusStamps[0].status.indexOf('nothing further to backfill') !== -1);
});

test('computeGhlSyncFixes_ stamps GHL Match Status when a disposition conflict leaves the row incomplete, naming the conflict specifically', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Conflicted Contact', Rep: 'Sean', 'Prospect Email': 'x@x.com', 'Outcome Disposition': '' })
  ];
  const stageLookup = {
    'closed-won': { pipelineName: 'SALES CALL pipeline', stageName: 'Closed Won', disposition: 'Sold' },
    'no-show': { pipelineName: 'Cold Calling 2', stageName: 'No Show', disposition: 'No-show' }
  };
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Conflicted Contact' }] }),
    ghlListOpportunitiesForContact_: () => ({ ok: true, opportunities: [{ pipelineStageId: 'closed-won' }, { pipelineStageId: 'no-show' }] })
  }, () => gas.computeGhlSyncFixes_('loc-1', stageLookup));
  assert.equal(result.statusStamps.length, 1);
  assert.ok(result.statusStamps[0].status.indexOf('disagree on outcome') !== -1);
});

test('computeGhlSyncFixes_ does NOT stamp a search failure — it is treated as transient and must be retried on the next run, unlike a genuine no-match/ambiguous result', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Transient Failure', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '' })
  ];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: false, status: 500, body: 'server error', contacts: [] })
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(result.stats.searchFailed, 1);
  assert.equal(result.statusStamps.length, 0, 'a transient failure must stay retryable, never parked permanently');
});

test('computeGhlSyncFixes_ skips a row already stamped GHL Match Status from an earlier run, with no GHL API call at all — the actual fix for the reported bug', () => {
  const dataRows = [
    fakeSalesCallLogRow({
      'Prospect Name': 'Already Checked', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '',
      'GHL Match Status': 'No GHL match 10/09/2026'
    })
  ];
  let searchCalls = 0;
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => { searchCalls++; return { ok: true, contacts: [] }; }
  }, () => gas.computeGhlSyncFixes_('loc-1', {}));
  assert.equal(searchCalls, 0, 'a row already stamped unresolved must never trigger a fresh GHL search');
  assert.equal(result.stats.skippedPreviouslyUnresolved, 1);
  assert.equal(result.fixes.length, 0);
  assert.equal(result.statusStamps.length, 0, 'must not re-stamp a row that is already stamped');
});

function withMockedGhlSyncFull_(mocks, fn) {
  const originals = {
    SpreadsheetApp: gas.SpreadsheetApp,
    Utilities: gas.Utilities,
    GHL_CONFIG: gas.GHL_CONFIG,
    ghlCheckSetup_: gas.ghlCheckSetup_,
    fetchGhlPipelines_: gas.fetchGhlPipelines_,
    buildGhlStageLookup_: gas.buildGhlStageLookup_,
    ghlSearchContactByName_: gas.ghlSearchContactByName_,
    ghlListOpportunitiesForContact_: gas.ghlListOpportunitiesForContact_
  };
  gas.Utilities = { sleep: () => {}, formatDate: realFormatDate };
  gas.GHL_CONFIG = Object.assign({}, gas.GHL_CONFIG, { ENABLED: true });
  gas.ghlCheckSetup_ = () => 'loc-1';
  gas.fetchGhlPipelines_ = () => [];
  gas.buildGhlStageLookup_ = () => ({});
  Object.assign(gas, mocks);
  try {
    return fn();
  } finally {
    Object.assign(gas, originals);
  }
}

test('syncGhlEmailAndDisposition_ writes GHL Match Status stamps to the sheet even when zero real fixes were found this run — the exact bug: the old early-return checked only fixes.length, so a run that only determined rows were unresolvable wrote nothing and every future run re-attempted the same dead rows from scratch', () => {
  const cells = {};
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Nobody Found', Rep: 'Sean', 'Prospect Email': '', 'Outcome Disposition': '' })
  ];
  const headerRow = gas.SALES_CALL_LOG_HEADERS.slice();
  const sheet = {
    getLastRow: () => dataRows.length + 1,
    getRange: (row, colArg, numRows) => {
      if (row === 1) return { getValues: () => [headerRow] };
      if (numRows !== undefined) return { getValues: () => dataRows };
      return { setValue(v) { cells[row + ':' + colArg] = v; return this; } };
    }
  };
  withMockedGhlSyncFull_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [] })
  }, () => gas.syncGhlEmailAndDisposition_());

  const statusCol = gas.SALES_CALL_LOG_HEADERS.indexOf('GHL Match Status') + 1;
  assert.ok(cells['2:' + statusCol], 'the status cell must actually be written even though no real fix was found');
  assert.ok(String(cells['2:' + statusCol]).indexOf('No GHL match') === 0);
});

// ---------------------------------------------------------------------------
// CRM hygiene checks (Phase9_GhlSync.gs) — Rules 2/3 + Tomás's own
// booked-without-appointment rule from the CRM Hygiene Automation doc.
// ---------------------------------------------------------------------------

test('parseSalesCallLogDate_ parses a "dd/MM/yyyy" text cell', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = gas.parseSalesCallLogDate_('01/09/2026');
  assert.equal(realFormatDate(result, 'America/New_York', 'yyyy/MM/dd'), '2026/09/01');
});

test('parseSalesCallLogDate_ parses a REAL Date-object cell, not just text (real bug found live 03/09/2026: getValues() hands back an actual Date for a genuine Sheets date cell — String(aDateObject) has no "/" at all, so the text-only parser silently treated every one of 471/471 live rows as unparseable)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  // Must be a Date built in the gas sandbox's OWN realm (gas.Date, exposed by gas_env.js for exactly
  // this) -- a host-realm `new Date(...)` fails `instanceof Date` inside the vm sandbox and would
  // silently fall through to the text-parsing branch instead of exercising the one under test.
  const result = gas.parseSalesCallLogDate_(new gas.Date(gas.Date.UTC(2026, 8, 1, 12, 0, 0))); // Sept 1 2026, midday UTC
  assert.equal(realFormatDate(result, 'America/New_York', 'yyyy/MM/dd'), '2026/09/01');
});

test('parseSalesCallLogDate_ returns null, not a throw, for blank/junk/malformed input', () => {
  gas.Utilities = { formatDate: realFormatDate };
  assert.equal(gas.parseSalesCallLogDate_(''), null);
  assert.equal(gas.parseSalesCallLogDate_(null), null);
  assert.equal(gas.parseSalesCallLogDate_('not a date'), null);
  assert.equal(gas.parseSalesCallLogDate_(new gas.Date(NaN)), null);
});

test('ghlStageLooksBooked_ matches any "...Booked" stage name across pipelines, not an exact list (GHL_PIPELINE_MAP.md shows this pattern repeated)', () => {
  assert.equal(gas.ghlStageLooksBooked_('Sales Call - Booked'), true);
  assert.equal(gas.ghlStageLooksBooked_('Discovery Call Booked'), true);
  assert.equal(gas.ghlStageLooksBooked_('Qualification Call Booked'), true);
  assert.equal(gas.ghlStageLooksBooked_('Podcast Booked On Calendar'), true);
  assert.equal(gas.ghlStageLooksBooked_('Closed Won'), false);
  assert.equal(gas.ghlStageLooksBooked_(''), false);
  assert.equal(gas.ghlStageLooksBooked_(null), false);
});

test('ghlCallReflectionGap_ returns null (not a finding) when the call is too recent to judge yet', () => {
  const now = new Date('2026-09-03T12:00:00Z').getTime();
  const callDate = new Date('2026-09-02T12:00:00Z'); // 1 day ago, grace is 3
  assert.equal(gas.ghlCallReflectionGap_(callDate, [], now, 3), null);
});

test('ghlCallReflectionGap_ returns null when no opportunity carries a usable timestamp (a response-shape gap, not evidence of neglect)', () => {
  const now = new Date('2026-09-10T12:00:00Z').getTime();
  const callDate = new Date('2026-09-01T12:00:00Z');
  assert.equal(gas.ghlCallReflectionGap_(callDate, [{ pipelineStageId: 'x' }], now, 3), null);
});

test('ghlCallReflectionGap_ flags true when the call is old enough and no opportunity was touched on/after it', () => {
  const now = new Date('2026-09-10T12:00:00Z').getTime();
  const callDate = new Date('2026-09-01T12:00:00Z');
  const opportunities = [{ pipelineStageId: 'x', updatedAt: '2026-08-20T00:00:00Z' }];
  assert.equal(gas.ghlCallReflectionGap_(callDate, opportunities, now, 3), true);
});

test('ghlCallReflectionGap_ flags false when an opportunity WAS touched on/after the call date, checking every plausible GHL field name', () => {
  const now = new Date('2026-09-10T12:00:00Z').getTime();
  const callDate = new Date('2026-09-01T12:00:00Z');
  assert.equal(gas.ghlCallReflectionGap_(callDate, [{ dateUpdated: '2026-09-02T00:00:00Z' }], now, 3), false);
  assert.equal(gas.ghlCallReflectionGap_(callDate, [{ lastStatusChangeAt: '2026-09-05T00:00:00Z' }], now, 3), false);
  assert.equal(gas.ghlCallReflectionGap_(callDate, [{ lastStageChangeAt: '2026-09-05T00:00:00Z' }], now, 3), false);
});

test('ghlContactIsUnpipelined_ is true only for zero opportunities', () => {
  assert.equal(gas.ghlContactIsUnpipelined_([]), true);
  assert.equal(gas.ghlContactIsUnpipelined_(null), true);
  assert.equal(gas.ghlContactIsUnpipelined_([{ pipelineStageId: 'x' }]), false);
});

test('ghlBookedWithoutFutureAppointmentGap_ returns null when nothing is in a Booked stage — nothing to check, not a finding', () => {
  const stageLookup = { 'closed-won': { stageName: 'Closed Won' } };
  assert.equal(gas.ghlBookedWithoutFutureAppointmentGap_([{ pipelineStageId: 'closed-won' }], stageLookup, false), null);
});

test('ghlBookedWithoutFutureAppointmentGap_ reports unverifiable rather than guessing a flag when hasFutureEvent is null (e.g. Tomás, whose calls aren\'t calendar-scanned)', () => {
  const stageLookup = { 'sc-booked': { stageName: 'Sales Call - Booked' } };
  const result = gas.ghlBookedWithoutFutureAppointmentGap_([{ pipelineStageId: 'sc-booked' }], stageLookup, null);
  assert.equal(result.flag, false);
  assert.equal(result.unverifiable, true);
});

test('ghlBookedWithoutFutureAppointmentGap_ flags true only when a Booked stage exists AND there is definitively no future appointment', () => {
  const stageLookup = { 'sc-booked': { stageName: 'Sales Call - Booked' } };
  const flagged = gas.ghlBookedWithoutFutureAppointmentGap_([{ pipelineStageId: 'sc-booked' }], stageLookup, false);
  assert.equal(flagged.flag, true);
  assert.deepEqual(Array.prototype.slice.call(flagged.bookedStages), ['Sales Call - Booked']);
  const clear = gas.ghlBookedWithoutFutureAppointmentGap_([{ pipelineStageId: 'sc-booked' }], stageLookup, true);
  assert.equal(clear.flag, false);
});

test('classifyGhlHygieneRow_ combines all three checks and returns null when nothing is wrong', () => {
  const now = new Date('2026-09-10T12:00:00Z').getTime();
  const result = gas.classifyGhlHygieneRow_({
    prospectName: 'Clean Contact', rep: 'Sean', callDateLabel: '01/09/2026',
    callDate: new Date('2026-09-01T12:00:00Z'),
    opportunities: [{ pipelineStageId: 'closed-won', updatedAt: '2026-09-02T00:00:00Z' }],
    stageLookup: { 'closed-won': { stageName: 'Closed Won' } },
    hasFutureEvent: null, nowMs: now
  });
  assert.equal(result, null);
});

test('classifyGhlHygieneRow_ reports every issue that applies, real combined case: an old opportunity untouched since long before the call, plus a Booked stage with no future appointment', () => {
  const now = new Date('2026-09-10T12:00:00Z').getTime();
  const result = gas.classifyGhlHygieneRow_({
    prospectName: 'Neglected Contact', rep: 'Bens', callDateLabel: '01/09/2026',
    callDate: new Date('2026-09-01T12:00:00Z'),
    opportunities: [{ pipelineStageId: 'sc-booked', updatedAt: '2026-08-01T00:00:00Z' }],
    stageLookup: { 'sc-booked': { stageName: 'Sales Call - Booked' } },
    hasFutureEvent: false, nowMs: now
  });
  assert.deepEqual(Array.prototype.slice.call(result.issues),
    ['call_not_reflected_in_ghl', 'booked_without_future_appointment']);
});

test('classifyGhlHygieneRow_ reports unpipelined_lead alone for a zero-opportunity contact — no timestamp to judge a reflection gap against, so that check stays silent rather than double-counting the same gap two ways', () => {
  const now = new Date('2026-09-10T12:00:00Z').getTime();
  const result = gas.classifyGhlHygieneRow_({
    prospectName: 'Unpipelined Contact', rep: 'Bens', callDateLabel: '01/09/2026',
    callDate: new Date('2026-09-01T12:00:00Z'),
    opportunities: [], stageLookup: {}, hasFutureEvent: null, nowMs: now
  });
  assert.deepEqual(Array.prototype.slice.call(result.issues), ['unpipelined_lead']);
});

test('repConfigByName_ finds a real CONFIG.REPS entry case/whitespace-insensitively, and returns null for a rep not calendar-scanned (Tomás)', () => {
  const sean = gas.repConfigByName_('  sean ');
  assert.ok(sean, 'expected a match for Sean');
  assert.equal(sean.name, 'Sean');
  assert.equal(gas.repConfigByName_('Tomás'), null);
  assert.equal(gas.repConfigByName_('Nobody'), null);
});

test('ghlHasFutureCalendarEvent_ returns null (unverifiable) for a rep with no calendar-scan config, never guessing false', () => {
  assert.equal(gas.ghlHasFutureCalendarEvent_('Tomás', 'Some Prospect', new Date('2026-09-10T12:00:00Z')), null);
});

test('ghlHasFutureCalendarEvent_ matches a future event by shared name token with the prospect, using the rep\'s real calendar lookup', () => {
  const originalGetEvents = gas.getRepCallEvents_;
  let capturedRepCfg = null;
  gas.getRepCallEvents_ = (repCfg) => {
    capturedRepCfg = repCfg;
    return [{ prospectGuess: 'Anthony Camperi' }];
  };
  try {
    assert.equal(gas.ghlHasFutureCalendarEvent_('Sean', 'Anthony Camperi - 2nd', new Date('2026-09-10T12:00:00Z')), true);
    assert.equal(capturedRepCfg.name, 'Sean');
    assert.equal(gas.ghlHasFutureCalendarEvent_('Sean', 'Unrelated Person', new Date('2026-09-10T12:00:00Z')), false);
  } finally {
    gas.getRepCallEvents_ = originalGetEvents;
  }
});

test('ghlHasFutureCalendarEvent_ returns null, not throws, when the calendar lookup itself fails', () => {
  const originalGetEvents = gas.getRepCallEvents_;
  gas.getRepCallEvents_ = () => { throw new Error('Calendar API down'); };
  try {
    assert.equal(gas.ghlHasFutureCalendarEvent_('Sean', 'Anyone', new Date('2026-09-10T12:00:00Z')), null);
  } finally {
    gas.getRepCallEvents_ = originalGetEvents;
  }
});

test('ghlHasFutureCalendarEvent_ hits CalendarApp only once per rep when given an eventsCache, not once per row (real cost found live 03/09/2026: Joana\'s calendar window was re-fetched over a dozen times in one scan)', () => {
  const originalGetEvents = gas.getRepCallEvents_;
  let calls = 0;
  gas.getRepCallEvents_ = () => { calls++; return [{ prospectGuess: 'Anthony Camperi' }]; };
  const cache = {};
  try {
    gas.ghlHasFutureCalendarEvent_('Sean', 'Anthony Camperi', new Date('2026-09-10T12:00:00Z'), cache);
    gas.ghlHasFutureCalendarEvent_('Sean', 'Someone Else', new Date('2026-09-10T12:00:00Z'), cache);
    gas.ghlHasFutureCalendarEvent_('Sean', 'A Third Person', new Date('2026-09-10T12:00:00Z'), cache);
    assert.equal(calls, 1, 'the second and third call for the same rep must reuse the cached event list');
  } finally {
    gas.getRepCallEvents_ = originalGetEvents;
  }
});

test('ghlHasFutureCalendarEvent_ caches a failed lookup too, so a broken calendar doesn\'t get retried on every row of the same rep', () => {
  const originalGetEvents = gas.getRepCallEvents_;
  let calls = 0;
  gas.getRepCallEvents_ = () => { calls++; throw new Error('Calendar API down'); };
  const cache = {};
  try {
    assert.equal(gas.ghlHasFutureCalendarEvent_('Sean', 'Anyone', new Date('2026-09-10T12:00:00Z'), cache), null);
    assert.equal(gas.ghlHasFutureCalendarEvent_('Sean', 'Someone Else', new Date('2026-09-10T12:00:00Z'), cache), null);
    assert.equal(calls, 1);
  } finally {
    gas.getRepCallEvents_ = originalGetEvents;
  }
});

test('groupGhlHygieneFindingsByRep_ buckets findings by rep, preserving each rep\'s own list', () => {
  const findings = [
    { prospectName: 'A', rep: 'Sean', issues: ['unpipelined_lead'] },
    { prospectName: 'B', rep: 'Bens', issues: ['unpipelined_lead'] },
    { prospectName: 'C', rep: 'Sean', issues: ['call_not_reflected_in_ghl'] }
  ];
  const byRep = gas.groupGhlHygieneFindingsByRep_(findings);
  assert.equal(byRep.Sean.length, 2);
  assert.equal(byRep.Bens.length, 1);
});

test('buildGhlHygieneReportForRep_ lists every finding with a human-readable label, in both plain text and HTML', () => {
  const report = gas.buildGhlHygieneReportForRep_([
    { prospectName: 'Jane Doe', callDateLabel: '01/09/2026', issues: ['unpipelined_lead', 'booked_without_future_appointment'] }
  ]);
  assert.ok(report.subject.indexOf('1 item') !== -1);
  assert.ok(report.body.indexOf('Jane Doe') !== -1);
  assert.ok(report.body.indexOf('GHL contact has no pipeline at all') !== -1);
  assert.ok(report.htmlBody.indexOf('<li>Jane Doe') !== -1);
  assert.ok(report.htmlBody.indexOf('no real future appointment') !== -1);
});

test('computeGhlHygieneFindings_ skips a row with no confident GHL match (no contact, or ambiguous), same conservative policy as the email/disposition sync', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'No Match', Rep: 'Sean', 'Call Date': '01/07/2026' })
  ];
  const originalDateFn = gas.dateAtMidnightInBusinessTimezone_;
  gas.dateAtMidnightInBusinessTimezone_ = () => new Date(Date.now() - 5 * 24 * 3600000); // genuinely inside the 30-day lookback window
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [] })
  }, () => gas.computeGhlHygieneFindings_('loc-1', {}));
  gas.dateAtMidnightInBusinessTimezone_ = originalDateFn;
  assert.equal(result.findings.length, 0);
  assert.equal(result.stats.inWindow, 1, 'the row must have been counted as in-window before being dropped for no match');
  assert.equal(result.stats.noGhlContact, 1);
  assert.equal(result.stats.checked, 0);
});

test('computeGhlHygieneFindings_ finds a real hygiene issue end to end: a confidently-matched, unpipelined contact', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Anthony Camperi', Rep: 'Sean', 'Call Date': '01/07/2026' })
  ];
  const originalDateFn = gas.dateAtMidnightInBusinessTimezone_;
  const originalGetEvents = gas.getRepCallEvents_;
  gas.dateAtMidnightInBusinessTimezone_ = () => new Date(Date.now() - 20 * 24 * 3600000);
  gas.getRepCallEvents_ = () => [];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Anthony Camperi' }] }),
    ghlListOpportunitiesForContact_: () => ({ ok: true, opportunities: [] })
  }, () => gas.computeGhlHygieneFindings_('loc-1', {}));
  gas.dateAtMidnightInBusinessTimezone_ = originalDateFn;
  gas.getRepCallEvents_ = originalGetEvents;
  assert.equal(result.stats.checked, 1);
  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0].issues.indexOf('unpipelined_lead') !== -1);
});

test('computeGhlHygieneFindings_ reads a REAL Date-object Call Date cell, not just text (the exact live bug, 03/09/2026 — see parseSalesCallLogDate_\'s own header comment)', () => {
  // gas.Date (not the host Date) -- same instanceof-across-realms reasoning as parseSalesCallLogDate_'s own tests above.
  const recentDate = new gas.Date(Date.now() - 5 * 24 * 3600000); // a real Date object, same as getValues() hands back for a genuine Sheets date cell
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Anthony Camperi', Rep: 'Sean', 'Call Date': recentDate })
  ];
  const originalGetEvents = gas.getRepCallEvents_;
  gas.getRepCallEvents_ = () => [];
  const result = withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Anthony Camperi' }] }),
    ghlListOpportunitiesForContact_: () => ({ ok: true, opportunities: [] })
  }, () => gas.computeGhlHygieneFindings_('loc-1', {}));
  gas.getRepCallEvents_ = originalGetEvents;
  assert.equal(result.stats.inWindow, 1, 'a real Date-object cell must be recognized as in-window, not silently dropped as unparseable');
  assert.equal(result.findings.length, 1);
});

test('computeGhlHygieneFindings_ fetches each rep\'s calendar only once for the whole scan, not once per matched row (the real cost problem found live 03/09/2026)', () => {
  const dataRows = [
    fakeSalesCallLogRow({ 'Prospect Name': 'Contact One', Rep: 'Joana', 'Call Date': new gas.Date(Date.now() - 3 * 24 * 3600000) }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Contact Two', Rep: 'Joana', 'Call Date': new gas.Date(Date.now() - 4 * 24 * 3600000) }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Contact Three', Rep: 'Joana', 'Call Date': new gas.Date(Date.now() - 5 * 24 * 3600000) })
  ];
  const originalGetEvents = gas.getRepCallEvents_;
  let calendarCalls = 0;
  gas.getRepCallEvents_ = () => { calendarCalls++; return []; };
  let searchCalls = 0;
  withMockedGhlSync_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeSalesCallLogSheet(dataRows) }) },
    ghlSearchContactByName_: (locationId, name) => {
      searchCalls++;
      return { ok: true, contacts: [{ id: 'c-' + searchCalls, name: name }] };
    },
    ghlListOpportunitiesForContact_: () => ({ ok: true, opportunities: [] })
  }, () => gas.computeGhlHygieneFindings_('loc-1', {}));
  gas.getRepCallEvents_ = originalGetEvents;
  assert.equal(searchCalls, 3, 'sanity check: all 3 rows must have actually been processed');
  assert.equal(calendarCalls, 1, 'Joana\'s calendar must be fetched once for the run, reused across all 3 of her rows');
});

// ---------------------------------------------------------------------------
// cleanProspectNameForSheet_ (Phase2_CallScoring.gs) — real values pulled
// straight from a live GHL contact-matching preview (28/08/2026): every one
// of these was already sitting in the Sales Call Log's Prospect Name column
// for Sean/Joana/Tomás, and every one of them failed to match a real GHL
// contact by name until cleaned.
// ---------------------------------------------------------------------------

test('cleanProspectNameForSheet_ strips a leading "M/D" date token (Sean\'s older Qualification Calls naming convention)', () => {
  assert.equal(gas.cleanProspectNameForSheet_('1/21 Anthony Camperi'), 'Anthony Camperi');
  assert.equal(gas.cleanProspectNameForSheet_('1/7 Desiree Doggett'), 'Desiree Doggett');
  assert.equal(gas.cleanProspectNameForSheet_('1/8 Sammy Lyon'), 'Sammy Lyon');
  assert.equal(gas.cleanProspectNameForSheet_('1/13 Meriam Hansen'), 'Meriam Hansen');
});

test('cleanProspectNameForSheet_ strips a trailing file extension left over from the original video filename (Joana\'s naming convention)', () => {
  assert.equal(gas.cleanProspectNameForSheet_('Will Salinas SC.mp4'), 'Will Salinas');
  assert.equal(gas.cleanProspectNameForSheet_('Marija Volkman QC & SC.mp4'), 'Marija Volkman');
  assert.equal(gas.cleanProspectNameForSheet_('Ryan Welch SC.mp4'), 'Ryan Welch');
  assert.equal(gas.cleanProspectNameForSheet_('Roger Hance QC & SC.mp4'), 'Roger Hance');
});

test('cleanProspectNameForSheet_ strips a trailing call-type descriptor with no file extension (Tomás\'s naming convention)', () => {
  assert.equal(gas.cleanProspectNameForSheet_('LUCY QUINONES Sales Call'), 'LUCY QUINONES');
  assert.equal(gas.cleanProspectNameForSheet_('Chelsea Fernandez Sales Call'), 'Chelsea Fernandez');
  assert.equal(gas.cleanProspectNameForSheet_('Monique Lewis Sales Call'), 'Monique Lewis');
  assert.equal(gas.cleanProspectNameForSheet_('Salisia Murray Sales Call'), 'Salisia Murray');
});

test('cleanProspectNameForSheet_ leaves an already-clean name (Bens\' parseLegacyFilename_ path) untouched', () => {
  assert.equal(gas.cleanProspectNameForSheet_('Peg Walsh'), 'Peg Walsh');
  assert.equal(gas.cleanProspectNameForSheet_('Nicole Freed'), 'Nicole Freed');
  assert.equal(gas.cleanProspectNameForSheet_(''), '');
  assert.equal(gas.cleanProspectNameForSheet_(null), '');
});

test('computeProspectNameFixes_ only touches fallback_heuristic rows for Sean/Joana/Tomás, and skips a row that\'s already clean', () => {
  const rows = [
    fakeSalesCallLogRow({ 'Prospect Name': '1/21 Anthony Camperi', Rep: 'Sean', 'Match Method': 'fallback_heuristic' }),
    fakeSalesCallLogRow({ 'Prospect Name': 'Peg Walsh', Rep: 'Bens', 'Match Method': 'fallback_heuristic' }), // Bens excluded regardless of match method
    fakeSalesCallLogRow({ 'Prospect Name': 'Already Clean', Rep: 'Joana', 'Match Method': 'fallback_heuristic' }), // no fix needed
    fakeSalesCallLogRow({ 'Prospect Name': 'Some Prospect', Rep: 'Sean', 'Match Method': 'exact_key' }) // real calendar match, not legacy -- out of scope
  ];
  const sheet = fakeSalesCallLogSheet(rows);
  const fixes = gas.computeProspectNameFixes_(sheet);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].oldName, '1/21 Anthony Camperi');
  assert.equal(fixes[0].newName, 'Anthony Camperi');
  assert.equal(fixes[0].rowIndex, 2);
});

// ---------------------------------------------------------------------------
// ICONS 100 tag backfill (Phase9_GhlSync.gs) — Tomás's ask, 08/09/2026.
// ---------------------------------------------------------------------------

test('ghlAddContactTag_ POSTs to the contact tags endpoint with the tag name wrapped in a tags array', () => {
  let capturedPath, capturedPayload;
  const originalPost = gas.ghlApiPost_;
  gas.ghlApiPost_ = (path, payload) => { capturedPath = path; capturedPayload = payload; return { status: 200 }; };
  try {
    gas.ghlAddContactTag_('contact-123', 'icons 100 guest');
    assert.equal(capturedPath, '/contacts/contact-123/tags');
    // Cross-realm gotcha (house convention): capturedPayload.tags was built
    // inside the vm sandbox, so assert.deepEqual's reference-equality check
    // on its Array prototype fails even though the structure matches —
    // compare via slice() per the documented workaround.
    assert.deepEqual(Array.prototype.slice.call(capturedPayload.tags), ['icons 100 guest']);
  } finally {
    gas.ghlApiPost_ = originalPost;
  }
});

function withMockedGhlContactSearch_(searchFn, fn) {
  const original = gas.ghlSearchContactByName_;
  gas.ghlSearchContactByName_ = searchFn;
  try {
    return fn();
  } finally {
    gas.ghlSearchContactByName_ = original;
  }
}

test('resolveIcons100TrackerContact_ resolves a single name-matching candidate', () => {
  const result = withMockedGhlContactSearch_(
    () => ({ ok: true, contacts: [{ id: 'c1', name: 'Anthony Camperi', email: 'a@x.com' }] }),
    () => gas.resolveIcons100TrackerContact_('loc-1', 'Anthony Camperi', '')
  );
  assert.equal(result.outcome, 'matched');
  assert.equal(result.contactId, 'c1');
  assert.equal(result.matchMethod, 'name_token');
});

test('resolveIcons100TrackerContact_ disambiguates multiple name-token candidates by an exact email match, rather than guessing (a WRITE, so this matters more than previewGhlMatching_\'s read-only "ambiguous" report)', () => {
  const result = withMockedGhlContactSearch_(
    () => ({
      ok: true,
      contacts: [
        { id: 'c1', name: 'Nicole Freed', email: 'wrong@x.com' },
        { id: 'c2', name: 'Nicole Freed', email: 'nicole.freed@yahoo.com' }
      ]
    }),
    () => gas.resolveIcons100TrackerContact_('loc-1', 'Nicole Freed', 'nicole.freed@yahoo.com')
  );
  assert.equal(result.outcome, 'matched');
  assert.equal(result.contactId, 'c2');
  assert.equal(result.matchMethod, 'email_exact');
});

test('resolveIcons100TrackerContact_ reports ambiguous, not a guess, when multiple candidates share name tokens and no email disambiguates them', () => {
  const result = withMockedGhlContactSearch_(
    () => ({ ok: true, contacts: [{ id: 'c1', name: 'Nicole Freed' }, { id: 'c2', name: 'Nicole Freed' }] }),
    () => gas.resolveIcons100TrackerContact_('loc-1', 'Nicole Freed', '')
  );
  assert.equal(result.outcome, 'ambiguous');
  assert.equal(result.candidateCount, 2);
});

test('resolveIcons100TrackerContact_ reports not_found when GHL returns only unrelated noise, same filtering as contactNameLooksLikeQuery_\'s "Desiree Doggett" case', () => {
  const result = withMockedGhlContactSearch_(
    () => ({ ok: true, contacts: [{ name: 'justin stamper' }, { name: 'avery carl' }] }),
    () => gas.resolveIcons100TrackerContact_('loc-1', 'Desiree Doggett', '')
  );
  assert.equal(result.outcome, 'not_found');
});

test('resolveIcons100TrackerContact_ reports search_failed rather than throwing when the GHL search itself errors', () => {
  const result = withMockedGhlContactSearch_(
    () => ({ ok: false, status: 500, body: 'server error' }),
    () => gas.resolveIcons100TrackerContact_('loc-1', 'Anyone', '')
  );
  assert.equal(result.outcome, 'search_failed');
  assert.equal(result.status, 500);
});

function fakeIcons100TrackerSheet(headerRow, rows) {
  const cells = {};
  return {
    getRange(row, col, numRows, numCols) {
      if (row === 1 && numRows === undefined) {
        // ensureIcons100TagStatusColumn_'s single-cell header read/write
        return {
          getValue: () => (headerRow[col - 1] === undefined ? '' : headerRow[col - 1]),
          setValue(v) { headerRow[col - 1] = v; return this; },
          setFontWeight() { return this; },
          setBackground() { return this; }
        };
      }
      if (row === 1) {
        return { getValues: () => [headerRow.slice(0, numCols)] };
      }
      if (numRows === undefined) {
        return {
          getValue: () => cells[row + ':' + col],
          setValue(v) { cells[row + ':' + col] = v; return this; }
        };
      }
      return { getValues: () => rows.slice(row - 2, row - 2 + numRows).map((r) => r.slice(0, numCols)) };
    },
    getLastRow: () => rows.length + 1
  };
}

test('ensureIcons100TagStatusColumn_ creates the status column when missing and returns its 1-indexed position', () => {
  const sheet = fakeIcons100TrackerSheet(gas.BENS_PODCAST_TRACKER_HEADERS.slice(), []);
  const col = gas.ensureIcons100TagStatusColumn_(sheet);
  assert.equal(col, gas.BENS_PODCAST_TRACKER_HEADERS.length + 1);
});

test('ensureIcons100TagStatusColumn_ is idempotent — returns the same column without complaint when it already exists', () => {
  const header = gas.BENS_PODCAST_TRACKER_HEADERS.slice();
  header[gas.BENS_PODCAST_TRACKER_HEADERS.length] = 'ICONS 100 Tag Status';
  const sheet = fakeIcons100TrackerSheet(header, []);
  const col = gas.ensureIcons100TagStatusColumn_(sheet);
  assert.equal(col, gas.BENS_PODCAST_TRACKER_HEADERS.length + 1);
  assert.equal(header[gas.BENS_PODCAST_TRACKER_HEADERS.length], 'ICONS 100 Tag Status', 'must not overwrite an already-correct header');
});

test('ensureIcons100TagStatusColumn_ throws rather than silently overwriting an unrelated value already in that column', () => {
  const header = gas.BENS_PODCAST_TRACKER_HEADERS.slice();
  header[gas.BENS_PODCAST_TRACKER_HEADERS.length] = 'Some Other Column';
  const sheet = fakeIcons100TrackerSheet(header, []);
  assert.throws(() => gas.ensureIcons100TagStatusColumn_(sheet), /Some Other Column/);
});

test('readIcons100TrackerRowsToProcess_ skips blank-name rows and rows already stamped "Tagged...", but keeps everything else', () => {
  const trackerCol = {}; gas.BENS_PODCAST_TRACKER_HEADERS.forEach((h, i) => { trackerCol[h] = i + 1; });
  const statusCol = gas.BENS_PODCAST_TRACKER_HEADERS.length + 1;
  const blankRow = new Array(statusCol).fill('');
  const row1 = blankRow.slice(); row1[trackerCol['Name'] - 1] = 'Anthony Camperi'; row1[statusCol - 1] = 'Tagged 10/09/2026 (c1, matched by name_token)';
  const row2 = blankRow.slice(); row2[trackerCol['Name'] - 1] = ''; // blank name
  const row3 = blankRow.slice(); row3[trackerCol['Name'] - 1] = 'Nicole Freed'; row3[trackerCol['Email'] - 1] = 'nicole.freed@yahoo.com';
  const row4 = blankRow.slice(); row4[trackerCol['Name'] - 1] = 'Ambiguous Guy'; row4[statusCol - 1] = 'Ambiguous 09/09/2026 — 2 candidates, needs manual review';
  const sheet = fakeIcons100TrackerSheet(gas.BENS_PODCAST_TRACKER_HEADERS.concat(['ICONS 100 Tag Status']), [row1, row2, row3, row4]);
  const toProcess = gas.readIcons100TrackerRowsToProcess_(sheet, trackerCol, statusCol);
  assert.equal(toProcess.length, 2, 'must skip the already-Tagged row and the blank-name row, but keep the not-yet-tagged and ambiguous rows');
  assert.equal(toProcess[0].name, 'Nicole Freed');
  assert.equal(toProcess[0].email, 'nicole.freed@yahoo.com');
  assert.equal(toProcess[1].name, 'Ambiguous Guy');
});

test('readIcons100TrackerRowsToProcess_ treats a missing status column (statusCol falsy) as every named row being unprocessed', () => {
  const trackerCol = {}; gas.BENS_PODCAST_TRACKER_HEADERS.forEach((h, i) => { trackerCol[h] = i + 1; });
  const row1 = new Array(gas.BENS_PODCAST_TRACKER_HEADERS.length).fill('');
  row1[trackerCol['Name'] - 1] = 'Someone New';
  const sheet = fakeIcons100TrackerSheet(gas.BENS_PODCAST_TRACKER_HEADERS.slice(), [row1]);
  const toProcess = gas.readIcons100TrackerRowsToProcess_(sheet, trackerCol, null);
  assert.equal(toProcess.length, 1);
  assert.equal(toProcess[0].name, 'Someone New');
});

test('extractLeadEmailFromReplyBody_ pulls the real lead address out of the first Gmail quote header, not the relay envelope (real bug: Lead Email always read as network@ardorseo.com)', () => {
  const body = 'On Wednesday, Aug 26, 2026 at 3:03 pm jborwick@chaseinternational.com wrote:\n' +
    'Not interested.\nThanks for the inquiry, please take me off your list.\nJennifer\n\n' +
    'On Mon, Aug 24, 2026 at 9:22 AM Joana Peixe <joanap@iconsrealestatecenter.com> wrote:\n> Hi Jennifer,';
  assert.equal(gas.extractLeadEmailFromReplyBody_(body), 'jborwick@chaseinternational.com');
});

test('extractLeadEmailFromReplyBody_ handles a bare (no display name) quote header the same as one with a name', () => {
  const body = 'On Wednesday, Aug 26, 2026 at 7:10 pm jnixrealtor@gmail.com wrote:\nYes please\n\n' +
    'On Wed, Aug 26, 2026 at 8:07 AM Joana Peixe <joanap@iconsrealestateco.com> wrote:\n> John, I\'ve tried reaching out';
  assert.equal(gas.extractLeadEmailFromReplyBody_(body), 'jnixrealtor@gmail.com');
});

test('extractLeadEmailFromReplyBody_ returns empty string (not a throw) for a body with no recognizable quote header, so the caller can fall back', () => {
  assert.equal(gas.extractLeadEmailFromReplyBody_('Sure, sounds good, call me tomorrow.'), '');
  assert.equal(gas.extractLeadEmailFromReplyBody_(''), '');
});

test('extractLeadEmailFromReplyBody_ takes the email closest to "wrote:", not the first one in the body (real bug, 29/08/2026: an HTML-derived body from extractHtmlBodyAsText_ has no newlines at all, so the old last-line-split logic collapsed the whole preceding body into one "line" and returned the FIRST email anywhere in it — usually the outreach signature\'s own address, not the lead\'s)', () => {
  // No newlines anywhere, same as extractHtmlBodyAsText_'s tag-stripped output — the pitch signature's
  // own address (network@ardorseo.com) sits well before the lead's, which is the one right before "wrote:".
  const body = 'Hi George, this is Sean from Icons, reach us any time at network@ardorseo.com if you have questions. ' +
    'On Wed, Aug 26, 2026 at 3:03 pm jborwick@chaseinternational.com wrote: Not interested, thanks anyway.';
  assert.equal(gas.extractLeadEmailFromReplyBody_(body), 'jborwick@chaseinternational.com');
});

test('extractLeadEmailFromReplyBody_ does not attribute an unrelated earlier email to the lead when the quote header itself has none (code-review catch, 29/08/2026: a lookback-window-based first pass at the HTML-collapsed-body fix above could still grab a distractor address, e.g. an outreach signature\'s own, if it happened to be the last email inside the window — must require the email to sit DIRECTLY before "wrote:", not just somewhere near it)', () => {
  const body = 'Hi George, this is Sean from Icons, reach us any time at network@ardorseo.com. ' +
    'On Wed, Aug 26, 2026 at 3:03 pm Jonathan Borwick wrote: Not interested.';
  assert.equal(gas.extractLeadEmailFromReplyBody_(body), '',
    'the quote header has no email of its own (name-only) — must not fall back to the earlier, unrelated signature address');
});

test('getMessageHeader_ finds a header by name and returns empty string when absent', () => {
  const message = { payload: { headers: [{ name: 'From', value: 'network@ardorseo.com' }, { name: 'Subject', value: 'Fwd: Hi' }] } };
  assert.equal(gas.getMessageHeader_(message, 'From'), 'network@ardorseo.com');
  assert.equal(gas.getMessageHeader_(message, 'Subject'), 'Fwd: Hi');
  assert.equal(gas.getMessageHeader_(message, 'To'), '');
  assert.equal(gas.getMessageHeader_({}, 'From'), '');
});

test('isDailyPracticeTranscriptDocName_ only matches the real "<video name> — Transcript" convention, not a doc with "Transcript" elsewhere in its name (real bug: a "— Feedback" doc with a mis-stripped "Transcript" survived and re-graded itself daily)', () => {
  assert.equal(gas.isDailyPracticeTranscriptDocName_('260820  speak with the spouse — Transcript'), true);
  assert.equal(gas.isDailyPracticeTranscriptDocName_('260820 — Transcript  speak with spouse'), false);
  assert.equal(gas.isDailyPracticeTranscriptDocName_('260820 — Transcript  speak with spouse — Feedback'), false);
  assert.equal(gas.isDailyPracticeTranscriptDocName_('260820  speak with the spouse.mp4'), false);
});

test('selectLateDailyPracticeFileName_ picks a late submission named with its own real (later) date, excluding generated docs (real bug: Sean\'s "260827 budget/partner/hospital" against a 260826 assignment)', () => {
  const names = [
    '260826  speak with the spouse.mp4',
    '260827  budget/partner/hospital',
    '260827  budget/partner/hospital — Transcript',
    '260825  old file — Feedback'
  ];
  // 260826 itself is present and would be caught by the exact-match check first;
  // this exercises the fallback in isolation, so drop it to simulate that case.
  const withoutExact = names.filter((n) => n !== '260826  speak with the spouse.mp4');
  assert.equal(gas.selectLateDailyPracticeFileName_(withoutExact, '260826'), '260827  budget/partner/hospital');
});

test('selectLateDailyPracticeFileName_ returns null when nothing on/after the assignment date qualifies', () => {
  assert.equal(gas.selectLateDailyPracticeFileName_(['260820  old file', '260820  old file — Transcript'], '260826'), null);
  assert.equal(gas.selectLateDailyPracticeFileName_([], '260826'), null);
});

test('selectLateDailyPracticeFileName_ picks the EARLIEST qualifying date, not the latest, when multiple late files exist', () => {
  const names = ['260829  much later', '260827  soonest after', '260828  in between'];
  assert.equal(gas.selectLateDailyPracticeFileName_(names, '260826'), '260827  soonest after');
});

test('selectLateDailyPracticeFileName_ falls through to the next candidate when the caller has excluded an already-claimed name (real bug: one late file got matched to two different assignment rows at once — 260827 satisfied both the 260825 and 260827 rows)', () => {
  const names = ['260828  next best', '260827  budget/partner/hospital'];
  // Simulates checkDailyPracticeComplianceRow_ filtering out anything another
  // row already pinned (claimedFiles) before calling this — the row for
  // 260825 must NOT be able to claim the same file the 260827 row already has.
  const excludingClaimed = names.filter((n) => n !== '260827  budget/partner/hospital');
  assert.equal(gas.selectLateDailyPracticeFileName_(excludingClaimed, '260825'), '260828  next best');
});

// Minimal DriveApp-shaped fakes for listDailyPracticeFilesRecursive_/findDailyPracticeFileByName_.
// next() advances its own index eagerly (not lazily on .getName()) — matching real
// Apps Script FileIterator behavior. A prior version of this mock advanced lazily,
// which caused a real infinite loop against code that stores the returned file
// before reading its name (confirmed live 28/08/2026 while adding these helpers).
function fakeFileIterator_(names) {
  let i = 0;
  return { hasNext: () => i < names.length, next: () => { const n = names[i]; i++; return { getName: () => n }; } };
}
function fakeDriveFolder_(rootNames, subfolders) {
  return {
    getFiles: () => fakeFileIterator_(rootNames),
    getFilesByName: (name) => {
      const found = rootNames.indexOf(name) !== -1;
      let served = false;
      return { hasNext: () => found && !served, next: () => { served = true; return { getName: () => name }; } };
    },
    getFolders: () => {
      const subs = (subfolders || []).map((names) => fakeDriveSubfolder_(names));
      let i = 0;
      return { hasNext: () => i < subs.length, next: () => { const s = subs[i]; i++; return s; } };
    }
  };
}
function fakeDriveSubfolder_(names) {
  return {
    getFiles: () => fakeFileIterator_(names),
    getFilesByName: (name) => {
      const found = names.indexOf(name) !== -1;
      let served = false;
      return { hasNext: () => found && !served, next: () => { served = true; return { getName: () => name }; } };
    }
  };
}

test('listDailyPracticeFilesRecursive_ includes files directly in the folder plus one level into each subfolder (real bug, confirmed live 28/08/2026: Bens\' Zoom exports landed inside a same-named subfolder — DriveApp.getFiles() never recurses, so 5 real completed drills were invisible to every scan in this file)', () => {
  const folder = fakeDriveFolder_(
    ['260819  root file'],
    [['260827_objection_practice.mp4', '260827.txt'], ['260826_objection_practice.mp4']]
  );
  // .join() on a string comparison sidesteps deepEqual across the gas vm
  // realm's Array vs. the test file's own Array (same class of issue as
  // resolveDailyPracticeFileMatches_'s object-identity fix above).
  const names = gas.listDailyPracticeFilesRecursive_(folder).map((f) => f.getName()).sort().join('|');
  assert.equal(names, ['260819  root file', '260826_objection_practice.mp4', '260827.txt', '260827_objection_practice.mp4'].sort().join('|'));
});

test('listDailyPracticeFilesRecursive_ does not descend two levels — only the folder itself and its immediate subfolders', () => {
  const folder = fakeDriveFolder_(['top.mp4'], [['nested.mp4']]);
  const names = gas.listDailyPracticeFilesRecursive_(folder).map((f) => f.getName()).sort().join('|');
  assert.equal(names, ['nested.mp4', 'top.mp4'].join('|'));
});

test('findDailyPracticeFileByName_ finds a file that only exists one level into a subfolder, not just directly in the folder', () => {
  const folder = fakeDriveFolder_(['unrelated.mp4'], [['260827_objection_practice.mp4']]);
  const found = gas.findDailyPracticeFileByName_(folder, '260827_objection_practice.mp4');
  assert.ok(found, 'expected to find the nested file');
  assert.equal(found.getName(), '260827_objection_practice.mp4');
});

test('findDailyPracticeFileByName_ returns null (not throw) when the name exists nowhere', () => {
  const folder = fakeDriveFolder_(['unrelated.mp4'], [['also-unrelated.mp4']]);
  assert.equal(gas.findDailyPracticeFileByName_(folder, '260827_objection_practice.mp4'), null);
});

test('resolveDailyPracticeFileMatches_ never lets a late-fallback match steal another row\'s own exact match, regardless of processing order (real bug: 260825, processed first in sheet order, grabbed 260827\'s own exact file via late-fallback before 260827 got a turn)', () => {
  const rows = [{ dateStr: '260825' }, { dateStr: '260827' }]; // 260825 listed first, as it is in the real sheet
  const candidateNames = ['260827  budget/partner/hospital'];
  const matches = gas.resolveDailyPracticeFileMatches_(rows, candidateNames);
  assert.equal(matches['260827'], '260827  budget/partner/hospital');
  assert.equal(matches['260825'], undefined); // no file left for the late-fallback phase — must NOT get 260827's file
});

test('resolveDailyPracticeFileMatches_ gives a late file to the earliest still-unmatched row when there is no exact match for anyone', () => {
  const rows = [{ dateStr: '260827' }, { dateStr: '260825' }]; // order shouldn't matter — sorted internally
  const candidateNames = ['260828  only file available'];
  const matches = gas.resolveDailyPracticeFileMatches_(rows, candidateNames);
  assert.equal(matches['260825'], '260828  only file available');
  assert.equal(matches['260827'], undefined); // only one file existed; the earlier assignment day claims it
});

test('resolveDailyPracticeFileMatches_ assigns exact matches for every row first, then late-fallback (earliest still-unmatched row first) only for what remains', () => {
  const rows = [{ dateStr: '260825' }, { dateStr: '260826' }, { dateStr: '260827' }];
  const candidateNames = ['260827  exact for 827', '260828  late candidate']; // 826 has no exact match
  const matches = gas.resolveDailyPracticeFileMatches_(rows, candidateNames);
  assert.equal(matches['260827'], '260827  exact for 827'); // exact match claimed first
  assert.equal(matches['260825'], '260828  late candidate'); // earliest still-unmatched row claims the one remaining late candidate
  assert.equal(matches['260826'], undefined); // nothing left for it this pass
});

test('resolveDailyPracticeFileMatches_ returns an empty result when there are no candidate files at all', () => {
  const matches = gas.resolveDailyPracticeFileMatches_([{ dateStr: '260825' }], []);
  assert.equal(Object.keys(matches).length, 0);
});

test('sortDailyPracticeFileClaimantsByRightfulOwner_ puts the claimant with the LARGEST dateStr first (real bug: "260827 budget/partner/hospital" got pinned to both the 260825 and 260827 rows for Sean before double-claim tracking existed — 260827 is the rightful match)', () => {
  const claimants = [
    { rep: 'Sean', dateStr: '260825', matchedFile: '260827  budget/partner/hospital' },
    { rep: 'Sean', dateStr: '260827', matchedFile: '260827  budget/partner/hospital' }
  ];
  const sorted = gas.sortDailyPracticeFileClaimantsByRightfulOwner_(claimants);
  assert.equal(sorted[0].dateStr, '260827');
  assert.equal(sorted[1].dateStr, '260825');
  // Original array is untouched (pure sort, per the function's own comment).
  assert.equal(claimants[0].dateStr, '260825');
});

test('repairDuplicateDailyPracticeFileClaims_ reverts every non-rightful claimant to open with its pin cleared, leaves the rightful owner and unique claims untouched', () => {
  const written = [];
  const fakeSheet = {
    getRange: (rowIndex, col) => ({
      setValue: (v) => written.push({ rowIndex, col, value: v })
    })
  };
  const rows = [
    { rowIndex: 2, rep: 'Sean', dateStr: '260825', status: 'file_received', matchedFile: '260827  budget/partner/hospital' },
    { rowIndex: 3, rep: 'Sean', dateStr: '260827', status: 'file_received', matchedFile: '260827  budget/partner/hospital' },
    { rowIndex: 4, rep: 'Joana', dateStr: '260826', status: 'file_received', matchedFile: '260826  some file' } // unique claim, untouched
  ];
  gas.repairDuplicateDailyPracticeFileClaims_(fakeSheet, rows, false);

  // Only the loser (260825) got written: status -> 'open' (col 4), matchedFile -> '' (col 7).
  assert.deepEqual(written, [
    { rowIndex: 2, col: 4, value: 'open' },
    { rowIndex: 2, col: 7, value: '' }
  ]);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].matchedFile, '');
  assert.equal(rows[1].status, 'file_received'); // rightful owner untouched
  assert.equal(rows[1].matchedFile, '260827  budget/partner/hospital');
  assert.equal(rows[2].matchedFile, '260826  some file'); // unrelated unique claim untouched
});

test('repairDuplicateDailyPracticeFileClaims_ writes nothing in dry-run mode but still updates the in-memory rows so the rest of that preview pass sees the repair', () => {
  const fakeSheet = { getRange: () => { throw new Error('must not write in dry-run'); } };
  const rows = [
    { rowIndex: 2, rep: 'Sean', dateStr: '260825', status: 'file_received', matchedFile: 'x.mp4' },
    { rowIndex: 3, rep: 'Sean', dateStr: '260827', status: 'file_received', matchedFile: 'x.mp4' }
  ];
  gas.repairDuplicateDailyPracticeFileClaims_(fakeSheet, rows, true);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].matchedFile, '');
});

function fakeStopThread_(messages) {
  return { getMessages: () => messages };
}
function fakeStopMessage_(from, body) {
  return { getFrom: () => from, getPlainBody: () => body };
}

test('repairFalselyCancelledDailyPracticeRows_ reverts a cancelled row to open when its tracked thread has no real cancel/stop message (real bug, confirmed live 28/08/2026: Bens\' and Joana\'s 260824-260826 rows were all cancelled with no actual stop reply anywhere on their real threads — a mistracked thread ID from before the send-thread fix)', () => {
  const written = [];
  const fakeSheet = { getRange: (rowIndex, col) => ({ setValue: (v) => written.push({ rowIndex, col, value: v }) }) };
  const thread = fakeStopThread_([
    fakeStopMessage_('Daily Practice Reminder Bot <kris@iconsofrealestate.com>', 'Record a video practicing objection handling...'),
    fakeStopMessage_('bens@iconsofrealestate.com', 'Copy, will do')
  ]);
  gas.GmailApp = { getThreadById: () => thread };
  const rows = [{ rowIndex: 5, rep: 'Bens', dateStr: '260824', status: 'cancelled', threadId: 'thread-abc' }];
  gas.repairFalselyCancelledDailyPracticeRows_(fakeSheet, rows, false);
  assert.equal(rows[0].status, 'open');
  assert.deepEqual(written, [{ rowIndex: 5, col: 4, value: 'open' }]);
});

test('repairFalselyCancelledDailyPracticeRows_ leaves a row cancelled when its thread genuinely has a real cancel/stop reply from Kris or Tomás', () => {
  const fakeSheet = { getRange: () => { throw new Error('must not write — this row is genuinely still cancelled'); } };
  const thread = fakeStopThread_([
    fakeStopMessage_('kris@iconsofrealestate.com', 'please cancel this one, not needed')
  ]);
  gas.GmailApp = { getThreadById: () => thread };
  const rows = [{ rowIndex: 5, rep: 'Bens', dateStr: '260824', status: 'cancelled', threadId: 'thread-abc' }];
  gas.repairFalselyCancelledDailyPracticeRows_(fakeSheet, rows, false);
  assert.equal(rows[0].status, 'cancelled');
});

test('repairFalselyCancelledDailyPracticeRows_ leaves a row alone when it has no tracked thread at all — nothing to verify against', () => {
  const fakeSheet = { getRange: () => { throw new Error('must not write — no thread to check'); } };
  gas.GmailApp = { getThreadById: () => { throw new Error('must not be called'); } };
  const rows = [{ rowIndex: 5, rep: 'Bens', dateStr: '260819', status: 'cancelled', threadId: '' }];
  gas.repairFalselyCancelledDailyPracticeRows_(fakeSheet, rows, false);
  assert.equal(rows[0].status, 'cancelled');
});

test('repairFalselyCancelledDailyPracticeRows_ ignores rows that aren\'t cancelled', () => {
  const fakeSheet = { getRange: () => { throw new Error('must not write — not a cancelled row'); } };
  gas.GmailApp = { getThreadById: () => { throw new Error('must not be called'); } };
  const rows = [{ rowIndex: 5, rep: 'Bens', dateStr: '260827', status: 'open', threadId: 'thread-abc' }];
  gas.repairFalselyCancelledDailyPracticeRows_(fakeSheet, rows, false);
  assert.equal(rows[0].status, 'open');
});

test('repairFalselyCancelledDailyPracticeRows_ writes nothing in dry-run mode but still updates the in-memory row', () => {
  const fakeSheet = { getRange: () => { throw new Error('must not write in dry-run'); } };
  const thread = fakeStopThread_([]);
  gas.GmailApp = { getThreadById: () => thread };
  const rows = [{ rowIndex: 5, rep: 'Bens', dateStr: '260824', status: 'cancelled', threadId: 'thread-abc' }];
  gas.repairFalselyCancelledDailyPracticeRows_(fakeSheet, rows, true);
  assert.equal(rows[0].status, 'open');
});

test('checkDailyPracticeCompliance_ end-to-end: repairing a double-claim in one pass must not let the freed row immediately re-steal the same file from the rightful owner (real bug, confirmed live 28/08/2026: repair reverted 260825, then match-resolution re-pinned it to 260827\'s own file in the SAME run, because 260827 — already matched — never entered the "unmatched" set and so its file looked free in a plain folder scan)', () => {
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  try {
    const recentTimestamp = new Date().toISOString();
    // Row order matches the live sheet: 260825 before 260827.
    const data = [
      ['Sean', '260825', '', 'file_received', recentTimestamp, 0, '260827  budget/partner/hospital'],
      ['Sean', '260827', '', 'file_received', '', 0, '260827  budget/partner/hospital']
    ];
    const fakeSheet = {
      getLastRow: () => data.length + 1,
      getLastColumn: () => 8,
      getRange: (row, col, numRows) => ({
        getValues: () => data.slice(row - 2, row - 2 + (numRows || 1)),
        setValue: (v) => { data[row - 2][col - 1] = v; },
        setValues: (vals) => { vals[0].forEach((v, i) => { data[row - 2][col - 1 + i] = v; }); }
      })
    };
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet, insertSheet: () => fakeSheet }) };

    const folderFileNames = ['260827  budget/partner/hospital'];
    const fakeFolder = {
      getFiles: () => {
        let i = 0;
        return { hasNext: () => i < folderFileNames.length, next: () => { const name = folderFileNames[i]; i++; return { getName: () => name }; } };
      },
      getFilesByName: (name) => {
        let served = false;
        const exists = folderFileNames.indexOf(name) !== -1;
        return { hasNext: () => exists && !served, next: () => { served = true; return { getName: () => name }; } };
      },
      getFolders: () => ({ hasNext: () => false }) // no subfolders in this scenario
    };
    gas.DriveApp = { getFolderById: () => fakeFolder };

    gas.checkDailyPracticeCompliance_(false);

    // 260825 must stay freed — not re-claim 260827's file in this same run.
    assert.equal(data[0][3], 'open');
    assert.equal(data[0][6], '');
    // 260827's own claim must survive untouched throughout.
    assert.equal(data[1][3], 'file_received');
    assert.equal(data[1][6], '260827  budget/partner/hospital');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
  }
});

test('checkDailyPracticeCompliance_ end-to-end: a file claimed by a row that has since graded out of the active set must stay off-limits to every other row (real bug, confirmed live 28/08/2026: 260827 graded — dropping out of the open/file_received filter — and 260825 immediately re-claimed its file, because the exclusion set was built only from the active rows, not from every row that ever registered a claim)', () => {
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  try {
    const data = [
      ['Sean', '260825', '', 'open', '', 0, ''],
      ['Sean', '260827', '', 'graded', '2026-08-28T00:21:31.932Z', 1, '260827  budget/partner/hospital']
    ];
    const fakeSheet = {
      getLastRow: () => data.length + 1,
      getLastColumn: () => 8,
      getRange: (row, col, numRows) => ({
        getValues: () => data.slice(row - 2, row - 2 + (numRows || 1)),
        setValue: (v) => { data[row - 2][col - 1] = v; },
        setValues: (vals) => { vals[0].forEach((v, i) => { data[row - 2][col - 1 + i] = v; }); }
      })
    };
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet, insertSheet: () => fakeSheet }) };

    // The folder still physically contains the graded file (its Transcript/
    // Feedback docs exist too, but those are filtered out by name already).
    const folderFileNames = ['260827  budget/partner/hospital'];
    const fakeFolder = {
      getFiles: () => {
        let i = 0;
        return { hasNext: () => i < folderFileNames.length, next: () => { const name = folderFileNames[i]; i++; return { getName: () => name }; } };
      },
      getFilesByName: () => ({ hasNext: () => false, next: () => { throw new Error('should not be called'); } }),
      getFolders: () => ({ hasNext: () => false }) // no subfolders in this scenario
    };
    gas.DriveApp = { getFolderById: () => fakeFolder };

    // Live (not dryRun): dryRun never persists a match to the sheet at all,
    // which would make this assertion pass trivially whether or not the bug
    // is actually fixed. 260825's own nag send will throw against the
    // unstubbed MailApp — that's expected and gets swallowed by
    // checkDailyPracticeCompliance_'s per-row try/catch; it happens after
    // (and is irrelevant to) the matching writes this test checks.
    gas.checkDailyPracticeCompliance_(false);

    // 260825 must NOT claim the graded row's file.
    assert.equal(data[0][6], '');
    // The graded row's own claim must remain untouched.
    assert.equal(data[1][6], '260827  budget/partner/hospital');
    assert.equal(data[1][3], 'graded');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
  }
});

test('installDailySelfPracticeTriggers_ installs exactly 3 triggers, not 4 (real bug, 31/08/2026: a dedicated PM runDailyPracticeCompliance trigger used to exist alongside the AM one and pushed the whole Apps Script project over its hard 20-installable-trigger cap — the PM pass is now folded into runDailyPracticeGrading instead, which already fires at the same hour)', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalCONFIG = gas.CONFIG;
  try {
    gas.ScriptApp = fakeScriptAppTriggers_([]);
    gas.CONFIG = Object.assign({}, gas.CONFIG, { BUSINESS_TIMEZONE: 'America/New_York' });

    gas.installDailySelfPracticeTriggers_();

    const handlerNames = gas.ScriptApp._triggers.map((t) => t.getHandlerFunction()).sort();
    assert.deepEqual(handlerNames, ['runDailyPracticeCompliance', 'runDailyPracticeGrading', 'sendDailyPracticeReminders_'],
      'must install exactly one trigger per handler — no dedicated PM compliance trigger, and no duplicates');
  } finally {
    gas.ScriptApp = originalScriptApp;
    gas.CONFIG = originalCONFIG;
  }
});

test('runDailyPracticeGrading also runs the PM compliance pass (checkDailyPracticeCompliance_) before grading, since it now covers the PM slot the old dedicated trigger used to (folded in 31/08/2026 to stay under Apps Script\'s trigger cap — GRADING_HOUR and COMPLIANCE_CHECK_HOUR_PM are the same hour, so the effective schedule is unchanged)', () => {
  const originalEnabled = gas.DAILY_PRACTICE_CONFIG.ENABLED;
  const originalCheckCompliance = gas.checkDailyPracticeCompliance_;
  const originalBuildAndGrade = gas.buildAndMaybeGradeDailyPractice_;
  const originalLockService = gas.LockService;
  const calls = [];
  try {
    gas.DAILY_PRACTICE_CONFIG.ENABLED = true;
    gas.checkDailyPracticeCompliance_ = () => calls.push('compliance');
    gas.buildAndMaybeGradeDailyPractice_ = () => calls.push('grading');
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };

    gas.runDailyPracticeGrading();

    assert.deepEqual(calls, ['compliance', 'grading'], 'the PM compliance pass must run before grading, both on every firing');
  } finally {
    gas.DAILY_PRACTICE_CONFIG.ENABLED = originalEnabled;
    gas.checkDailyPracticeCompliance_ = originalCheckCompliance;
    gas.buildAndMaybeGradeDailyPractice_ = originalBuildAndGrade;
    gas.LockService = originalLockService;
  }
});

test('isValidHandoffBriefSchema_ requires prospect_links (Joana\'s ask, 28/08/2026: handoff briefs should surface any website/social media the lead mentioned)', () => {
  assert.equal(gas.isValidHandoffBriefSchema_({
    lead_summary: 'a', issues_and_goals: 'b', podcast_fit_angle: 'c',
    unresolved_objections: 'd', prospect_links: 'e', other_notes: 'f'
  }), true);
  assert.equal(gas.isValidHandoffBriefSchema_({
    lead_summary: 'a', issues_and_goals: 'b', podcast_fit_angle: 'c',
    unresolved_objections: 'd', other_notes: 'f'
  }), false);
});

test('buildHandoffBriefEmailBody_ includes a WEBSITE / SOCIAL MEDIA section with the extracted links', () => {
  const brief = {
    lead_summary: 'Runs a boutique brokerage.',
    issues_and_goals: 'Wants more inbound leads.',
    podcast_fit_angle: 'Podcast builds authority.',
    unresolved_objections: 'None identified',
    prospect_links: 'https://acmerealty.com, instagram.com/acmerealty',
    other_notes: 'None'
  };
  const ctx = {
    nextRepFirstName: 'Joana', prospectName: 'Crystal Gargiulo', nextCallType: 'QC',
    nextCallDateStr: '29/08/2026', nextCallTimeStr: '10:00',
    priorRep: 'Bens', priorCallDateStr: '28/08/2026', priorCallType: 'Recording'
  };
  const body = gas.buildHandoffBriefEmailBody_(brief, ctx);
  assert.ok(body.indexOf('WEBSITE / SOCIAL MEDIA') !== -1);
  assert.ok(body.indexOf('https://acmerealty.com, instagram.com/acmerealty') !== -1);
});

test('buildHandoffBriefEmailHtml_ renders the extracted links as clickable <a> tags, not plain text', () => {
  const brief = {
    lead_summary: 'a', issues_and_goals: 'b', podcast_fit_angle: 'c',
    unresolved_objections: 'None identified',
    prospect_links: 'https://acmerealty.com, www.instagram.com/acmerealty',
    other_notes: 'None'
  };
  const ctx = {
    nextRepFirstName: 'Joana', prospectName: 'Crystal Gargiulo', nextCallType: 'QC',
    nextCallDateStr: '29/08/2026', nextCallTimeStr: '10:00',
    priorRep: 'Bens', priorCallDateStr: '28/08/2026', priorCallType: 'Recording'
  };
  const html = gas.buildHandoffBriefEmailHtml_(brief, ctx);
  assert.ok(html.indexOf('<a href="https://acmerealty.com"') !== -1);
  assert.ok(html.indexOf('<a href="https://www.instagram.com/acmerealty"') !== -1);
});

test('buildHandoffBriefEmailHtml_ does not linkify a plain "Not mentioned on this call" value', () => {
  const brief = {
    lead_summary: 'a', issues_and_goals: 'b', podcast_fit_angle: 'c',
    unresolved_objections: 'None identified',
    prospect_links: 'Not mentioned on this call',
    other_notes: 'None'
  };
  const ctx = {
    nextRepFirstName: 'Joana', prospectName: 'Crystal Gargiulo', nextCallType: 'QC',
    nextCallDateStr: '29/08/2026', nextCallTimeStr: '10:00',
    priorRep: 'Bens', priorCallDateStr: '28/08/2026', priorCallType: 'Recording'
  };
  const html = gas.buildHandoffBriefEmailHtml_(brief, ctx);
  assert.ok(html.indexOf('<a href') === -1);
  assert.ok(html.indexOf('Not mentioned on this call') !== -1);
});

// --- Task: lead-confirmation reminder for Discovery calls (03/09/2026) ---
// Kris's ask: "he's not confirming [with the lead] that the lead will be
// there. Sometimes disco calls are booked a long way in advance. They need
// to be called the day before to ensure the lead will be there."

test('buildLeadConfirmationReminderEmail_ tells the rep to call the LEAD to confirm attendance, names the prospect and call time, and falls back honestly when the name could not be parsed', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const repCfg = { name: 'Sean', email: 'sean@iconsofrealestate.com' };
  const ev = {
    title: 'Discovery / Sabiha Razzak',
    prospectGuess: 'Sabiha Razzak',
    start: new gas.Date('2026-09-04T14:00:00Z')
  };
  const email = gas.buildLeadConfirmationReminderEmail_(repCfg, ev);
  assert.ok(email.subject.indexOf('Sabiha Razzak') !== -1, 'subject must name the prospect');
  assert.ok(email.subject.indexOf('Discovery') !== -1);
  assert.ok(email.body.indexOf('Sabiha Razzak') !== -1);
  assert.ok(email.body.toLowerCase().indexOf('call them today') !== -1,
    'the whole point — this must tell the rep to call the LEAD, not just remind them of the call');

  const evBareTitle = { title: 'Discovery', prospectGuess: 'Discovery', start: new gas.Date('2026-09-04T14:00:00Z') };
  const emailBare = gas.buildLeadConfirmationReminderEmail_(repCfg, evBareTitle);
  assert.ok(emailBare.body.indexOf('name not parsed') !== -1,
    'must say so honestly rather than printing the raw title as if it were a real name');
});

test('findUpcomingDiscoveryCallsForRep_/sendUpcomingLeadConfirmationReminders_ are wired into STANDING_AUTOMATION_HANDLERS_/installAllReadyTriggers_, same "no silent gap" discipline as every other phase (03/09/2026)', () => {
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('sendUpcomingLeadConfirmationReminders_') !== -1);
  assert.equal(typeof gas.LEAD_CONFIRMATION_CONFIG, 'object');
  assert.equal(gas.LEAD_CONFIRMATION_CONFIG.ENABLED, false, 'must start disabled — preview before enabling, same as every other phase');
});

// --- Task: prospect social/website link lookup via Google CSE (01/09/2026) ---
// Kris's ask: the model only ever reports a link the lead said verbatim on
// the call, so "Not mentioned on this call" was the common case — find real
// social/website links via a web search instead, clearly labeled unconfirmed.

test('parseSerperResults_ extracts {title, link, snippet} from a real Serper response shape, and returns [] for anything malformed', () => {
  const real = {
    organic: [
      { title: 'Jane Doe Realty', link: 'https://janedoerealty.com', snippet: 'Top agent in...' },
      { title: 'Jane Doe | LinkedIn', link: 'https://linkedin.com/in/janedoe' } // no snippet key at all
    ]
  };
  // Compare fields directly, not via assert.deepEqual — parsed[0] is a plain
  // object built by object-literal syntax executing inside the vm sandbox,
  // so it fails deepEqual's cross-realm prototype-identity check against a
  // literal built in this file (same pattern noted throughout this suite,
  // e.g. the repOwnEmails_ tests above).
  const parsed = gas.parseSerperResults_(real);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Jane Doe Realty');
  assert.equal(parsed[0].link, 'https://janedoerealty.com');
  assert.equal(parsed[0].snippet, 'Top agent in...');
  assert.equal(parsed[1].snippet, '', 'a missing snippet key must default to empty string, not throw');

  assert.equal(gas.parseSerperResults_(null).length, 0);
  assert.equal(gas.parseSerperResults_({}).length, 0, 'no organic array at all (e.g. an out-of-credits response) must not throw');
  assert.equal(gas.parseSerperResults_({ organic: 'not-an-array' }).length, 0);
  // Guards the migration itself: Google's old key must no longer be read.
  assert.equal(gas.parseSerperResults_({ items: [{ title: 'x', link: 'https://x.com' }] }).length, 0,
    'the old Custom Search "items" key must not be picked up any more');
  assert.equal(gas.parseSerperResults_({ organic: [{ title: 'no link here' }] }).length, 0,
    'a result with no link is useless and must be filtered out');
});

test('searchResultLooksLikeProspect_ requires every real name token, not just one, to accept a result', () => {
  const match = { title: 'Jane Doe Realty | Homes for Sale', snippet: 'Jane Doe has sold...' };
  assert.equal(gas.searchResultLooksLikeProspect_(match, 'Jane Doe'), true);

  const unrelated = { title: 'Best Pizza in Austin', snippet: 'Top 10 pizza joints' };
  assert.equal(gas.searchResultLooksLikeProspect_(unrelated, 'Jane Doe'), false,
    'a search engine returning something with zero relation to the queried name must read as no-match, same as contactNameLooksLikeQuery_ for GHL');

  const partial = { title: 'Doe Family Reunion 2026', snippet: 'Join the Doe family...' };
  assert.equal(gas.searchResultLooksLikeProspect_(partial, 'Jane Doe'), false,
    'sharing only the last name is NOT enough post-Serper-migration — whole-web results make a single-token match too easy to false-positive on');

  // Real miss caught live 10/09/2026, previewProspectLinksLookup(): "Lisa
  // Berg" matched on "Lisa" alone and surfaced Blackpink singer Lisa's
  // Wikipedia/Instagram/YouTube pages, zero relation to the prospect and
  // no "Berg" anywhere in them. Requiring every token rejects this while
  // still accepting a real match (the `match` case above, which does share
  // both "jane" and "doe").
  const wrongPersonSameFirstName = {
    title: 'Lisa (Japanese musician, born 1987) - Wikipedia',
    snippet: 'Lisa is a member of the South Korean girl group Blackpink...'
  };
  assert.equal(gas.searchResultLooksLikeProspect_(wrongPersonSameFirstName, 'Lisa Berg'), false,
    'sharing only the first name with an unrelated, far more famous person must not pass');
});

test('findProspectSocialLinks_ filters out non-matching results and returns only plausible links', () => {
  const originalSearch = gas.serperSearch_;
  try {
    gas.serperSearch_ = (query) => ({
      status: 200,
      json: {
        organic: [
          { title: 'Jane Doe Realty', link: 'https://janedoerealty.com', snippet: 'Jane Doe, agent' },
          { title: 'Completely Unrelated Business', link: 'https://someotherbiz.com', snippet: 'nothing to do with her' }
        ]
      }
    });
    const links = gas.findProspectSocialLinks_('Jane Doe');
    assert.deepEqual(links, ['https://janedoerealty.com']);
  } finally {
    gas.serperSearch_ = originalSearch;
  }
});

test('findProspectSocialLinks_ degrades to an empty list, never throws, on a non-200 status or a thrown error', () => {
  const originalSearch = gas.serperSearch_;
  try {
    gas.serperSearch_ = () => ({ status: 403, json: null, body: 'quota exceeded' });
    // .length, not assert.deepEqual against [] — the empty array is a literal
    // returned from inside the vm sandbox's own findProspectSocialLinks_ body,
    // so it fails deepEqual's cross-realm prototype-identity check.
    assert.equal(gas.findProspectSocialLinks_('Jane Doe').length, 0);

    gas.serperSearch_ = () => { throw new Error('network error'); };
    assert.equal(gas.findProspectSocialLinks_('Jane Doe').length, 0,
      'a lookup failure (missing credentials, quota, network) must never block brief generation over a nice-to-have link');
  } finally {
    gas.serperSearch_ = originalSearch;
  }
});

test('enrichProspectLinksWithWebSearch_ is a no-op while PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED is false', () => {
  const original = gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED;
  const originalFind = gas.findProspectSocialLinks_;
  try {
    gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED = false;
    gas.findProspectSocialLinks_ = () => { throw new Error('must not be called while disabled'); };
    const brief = { prospect_links: 'Not mentioned on this call' };
    const result = gas.enrichProspectLinksWithWebSearch_(brief, 'Jane Doe');
    assert.equal(result.prospect_links, 'Not mentioned on this call');
  } finally {
    gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED = original;
    gas.findProspectSocialLinks_ = originalFind;
  }
});

test('enrichProspectLinksWithWebSearch_ appends found links labeled unconfirmed, never blended into what the model reported the lead saying', () => {
  const original = gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED;
  const originalFind = gas.findProspectSocialLinks_;
  try {
    gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED = true;

    gas.findProspectSocialLinks_ = () => ['https://janedoerealty.com'];
    const notMentioned = gas.enrichProspectLinksWithWebSearch_({ prospect_links: 'Not mentioned on this call' }, 'Jane Doe');
    assert.match(notMentioned.prospect_links, /unconfirmed/);
    assert.match(notMentioned.prospect_links, /https:\/\/janedoerealty\.com/);

    const alreadyHadOne = gas.enrichProspectLinksWithWebSearch_(
      { prospect_links: 'https://acmerealty.com' }, 'Jane Doe');
    assert.match(alreadyHadOne.prospect_links, /https:\/\/acmerealty\.com/, 'must keep what the model actually grounded in the transcript');
    assert.match(alreadyHadOne.prospect_links, /unconfirmed/, 'and append the web-found link as a clearly separate, unconfirmed addition');

    gas.findProspectSocialLinks_ = () => [];
    const noneFound = gas.enrichProspectLinksWithWebSearch_({ prospect_links: 'Not mentioned on this call' }, 'Jane Doe');
    assert.equal(noneFound.prospect_links, 'Not mentioned on this call', 'no plausible match found must leave the field untouched, not print an empty unconfirmed block');
  } finally {
    gas.PROSPECT_LINKS_LOOKUP_CONFIG.ENABLED = original;
    gas.findProspectSocialLinks_ = originalFind;
  }
});

test('guessCallTypeFromTitle_ falls back to "upcoming" (not "call") when no known call type keyword is in the title — fixed 29/08/2026, was "call", which combined with the subject template\'s trailing " call" produced "your call call in ~24 hrs"', () => {
  assert.equal(gas.guessCallTypeFromTitle_('Crystal Gargiulo / ICONS of Real Estate'), 'upcoming');
  assert.equal(gas.guessCallTypeFromTitle_('Podcast Qualification Call / Tom Wood'), 'QC');
});

test('callTypePhrase_ never doubles "call" — real bug spotted live 28/08/2026: "Sales Call" (a genuine guessCallTypeFromTitle_ result) plus a hardcoded trailing " call" produced "your Sales Call call..."', () => {
  assert.equal(gas.callTypePhrase_('QC'), 'QC call');
  assert.equal(gas.callTypePhrase_('Discovery'), 'Discovery call');
  assert.equal(gas.callTypePhrase_('Sales Call'), 'Sales Call');
  assert.equal(gas.callTypePhrase_('upcoming'), 'upcoming call');
});

test('sendUpcomingHandoffBriefs_\'s subject template never doubles "call" for any real guessCallTypeFromTitle_ output', () => {
  ['QC', 'Discovery', 'Sales Call', 'upcoming'].forEach((callType) => {
    var subject = 'Joana — [Handoff Brief] Crystal Gargiulo — your ' + gas.callTypePhrase_(callType) + ' in ~24 hrs';
    var matches = subject.match(/call/gi) || [];
    assert.ok(matches.length <= 1, 'subject should mention "call" at most once: ' + subject);
  });
});

test('getAllTrackerRows_ treats a filled Outcome Disposition as logged, not just the Outcome Logged checkbox (real bug live 28/08/2026: Bens filled in Outcome Disposition exactly as the compliance email instructed, "Follow-up", and the bot kept nagging forever because it only ever checked Outcome Logged)', () => {
  const header = ['Prospect Name', 'Prospect Email', 'Call Date', 'Rep', 'Call Type', 'Outcome Logged', 'Outcome Disposition', 'Calendar Event ID'];
  const data = [
    header,
    // Outcome Logged blank, but Outcome Disposition filled — must count as logged.
    ['Joey Lamielle', '', '26/08/2026', 'Bens', 'Recording', '', 'Follow-up', '']
  ];
  const fakeSheet = {
    getDataRange: () => ({ getValues: () => data }),
    getName: () => 'Sales Call Log'
  };
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet, getSheets: () => [fakeSheet] }) };
  try {
    const repCfg = gas.CONFIG.REPS.filter((r) => r.name === 'Bens')[0];
    const rows = gas.getAllTrackerRows_(repCfg, '26/08/2026', gas.CONFIG.BUSINESS_TIMEZONE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].logged, true);
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

test('dailyPracticeScoreColor_ colors low scores red, mid amber, high green (Kris\'s ask 29/08/2026: color the score so it stands out)', () => {
  assert.equal(gas.dailyPracticeScoreColor_(2), '#c0392b');
  assert.equal(gas.dailyPracticeScoreColor_(3), '#b8860b');
  assert.equal(gas.dailyPracticeScoreColor_(4), '#1a7a3c');
  assert.equal(gas.dailyPracticeScoreColor_(5), '#1a7a3c');
});

test('buildDailyPracticeFeedbackEmail_ includes a styled htmlBody with bold labels and a colored score', () => {
  const result = {
    drill_type: 'objection',
    objection_type: 'timing',
    technique_used: true,
    technique_description: 'Partial Agree/Isolate/Repeat.',
    delivery_quality: 'hesitant',
    overall_score: 3,
    sharpen_next: 'Isolate time as the only obstacle before responding.',
    feedback_summary: '"I completely understand" — a real Agree step, but Isolate/Repeat were skipped.'
  };
  const email = gas.buildDailyPracticeFeedbackEmail_('Bens', '260825_objection_practice.mp4', result);
  assert.ok(email.htmlBody, 'expected an htmlBody to be present');
  assert.ok(email.htmlBody.indexOf('<strong>One thing to sharpen next:</strong>') !== -1);
  assert.ok(email.htmlBody.indexOf('<strong>Score:</strong>') !== -1);
  assert.ok(email.htmlBody.indexOf('color:#b8860b') !== -1, 'expected the amber color for a score of 3');
  assert.ok(email.htmlBody.indexOf('3/5') !== -1);
});

test('buildDailyPracticeFeedbackEmail_ italicizes quoted transcript excerpts and renders "For the record" as a real bulleted list (Kris\'s ask 31/08/2026)', () => {
  const result = {
    drill_type: 'objection',
    objection_type: 'budget',
    technique_used: true,
    technique_description: 'Agreed with the premise, then deflected instead of isolating.',
    delivery_quality: 'hesitant',
    overall_score: 3,
    sharpen_next: 'Isolate the objection before pivoting.',
    feedback_summary: '"That\'s a very great question" — a genuinely well-done Agree step, but you skipped Isolate entirely.'
  };
  const email = gas.buildDailyPracticeFeedbackEmail_('Bens', '260820_objection_practice.mp4', result);

  assert.ok(email.htmlBody.indexOf('<i>&quot;That\'s a very great question&quot;</i>') !== -1,
    'the quoted transcript excerpt must be wrapped in <i>, not plain text');
  assert.ok(email.htmlBody.indexOf('<ul') !== -1 && email.htmlBody.indexOf('<li>') !== -1,
    '"For the record" must render as a real <ul>/<li> list, not <br>-separated lines');
  assert.equal((email.htmlBody.match(/<li>/g) || []).length, 4,
    'expected 4 bullets: focus line, technique used, delivery, score');
});

test('buildDailyPracticeFeedbackEmail_ includes recording and transcript links when provided (Kris, 05/09/2026: "Include the link to the recording and transcript so I can easily check myself" — an escalation had no way to verify without manually hunting through Drive)', () => {
  const result = {
    drill_type: 'framework', objection_type: 'n/a', framework_topic: 'Framework Explanation',
    technique_used: false, technique_description: '', delivery_quality: 'hesitant',
    overall_score: 1, sharpen_next: 'Name each piece out loud.',
    feedback_summary: '"we focus on the two critical things" — never actually named.'
  };
  const links = { recordingUrl: 'https://drive.google.com/file/d/REC123/view', transcriptUrl: 'https://drive.google.com/file/d/DOC456/view' };
  const email = gas.buildDailyPracticeFeedbackEmail_('Sean', '260903 Framework Explanation.mp4', result, links);

  assert.ok(email.body.indexOf('Recording: https://drive.google.com/file/d/REC123/view') !== -1);
  assert.ok(email.body.indexOf('Transcript: https://drive.google.com/file/d/DOC456/view') !== -1);
  assert.ok(email.htmlBody.indexOf('<a href="https://drive.google.com/file/d/REC123/view">Recording</a>') !== -1);
  assert.ok(email.htmlBody.indexOf('<a href="https://drive.google.com/file/d/DOC456/view">Transcript</a>') !== -1);
});

test('buildDailyPracticeFeedbackEmail_ omits a missing link entirely rather than rendering a broken one (a moved/deleted source file, or an old call site that never passed links at all)', () => {
  const result = {
    drill_type: 'objection', objection_type: 'timing', technique_used: true, technique_description: 'x',
    delivery_quality: 'good', overall_score: 4, sharpen_next: 'x', feedback_summary: '"x" — fine.'
  };
  const noLinks = gas.buildDailyPracticeFeedbackEmail_('Sean', 'x.mp4', result);
  assert.equal(noLinks.body.indexOf('Recording:'), -1);
  assert.equal(noLinks.body.indexOf('Transcript:'), -1);
  assert.equal(noLinks.htmlBody.indexOf('<a href='), -1);

  const transcriptOnly = gas.buildDailyPracticeFeedbackEmail_('Sean', 'x.mp4', result, { transcriptUrl: 'https://drive.google.com/x' });
  assert.equal(transcriptOnly.body.indexOf('Recording:'), -1);
  assert.ok(transcriptOnly.body.indexOf('Transcript: https://drive.google.com/x') !== -1);
  assert.equal(transcriptOnly.htmlBody.indexOf('Recording</a>'), -1);
  assert.ok(transcriptOnly.htmlBody.indexOf('Transcript</a>') !== -1);
});

test('dailyPracticeSourceFileName_ strips the "— Transcript" suffix without appending "— Feedback" (unlike dailyPracticeFeedbackDocName_), recovering the original recording\'s filename', () => {
  assert.equal(gas.dailyPracticeSourceFileName_('260903 Framework Explanation.mp4 — Transcript'), '260903 Framework Explanation.mp4');
  assert.equal(gas.dailyPracticeSourceFileName_('260820_objection_practice.mp4 - Transcript'), '260820_objection_practice.mp4');
});

test('deliverDailyPracticeGrading_ CCs Kris and Tomás on every standalone feedback email, not just escalations (Kris\'s ask 01/09/2026 — a score-3 email had gone out to Bens with no CC at all)', () => {
  const repCfg = { name: 'Bens', email: 'bens@iconsofrealestate.com' };
  const result = { overall_score: 3 }; // above ESCALATE_AT_OR_BELOW (2) — must still be CC'd
  const email = { subject: 'Practice Drill Feedback — x', body: 'body text', htmlBody: '<p>body</p>' };

  let captured = null;
  const originalGuardedSend = gas.guardedSend_;
  const originalDocumentApp = gas.DocumentApp;
  const originalDriveApp = gas.DriveApp;
  gas.guardedSend_ = (to, subject, body, options, recipientsNeeded) => {
    captured = { to, options, recipientsNeeded };
    return true;
  };
  const fakeDoc = { getBody: () => ({ setText: () => {} }), saveAndClose: () => {}, getId: () => 'doc-id' };
  gas.DocumentApp = { create: () => fakeDoc };
  gas.DriveApp = { getFileById: () => ({ moveTo: () => {} }) };
  try {
    const delivered = gas.deliverDailyPracticeGrading_(
      'Bens', repCfg, { name: () => 'folder' }, 'x.mp4', result, email,
      /*escalate=*/false, /*dryRun=*/false, /*replyThreadId=*/null);
    assert.equal(delivered, true);
  } finally {
    gas.guardedSend_ = originalGuardedSend;
    gas.DocumentApp = originalDocumentApp;
    gas.DriveApp = originalDriveApp;
  }
  assert.ok(captured, 'expected guardedSend_ to be called');
  assert.ok(captured.options.cc.indexOf(gas.CONFIG.KRIS_EMAIL) !== -1, 'Kris must be CC\'d even without an escalation');
  assert.ok(captured.options.cc.indexOf(gas.CONFIG.TOMAS_EMAIL) !== -1, 'Tomás must be CC\'d even without an escalation');
  assert.equal(captured.recipientsNeeded, 3, 'quota check must count rep + 2 CCs, not just the rep');
});

test('salesCallLogRowLink_ builds a deep link to the exact Sales Call Log row', () => {
  const fakeSheet = { getSheetId: () => 987654321 };
  const link = gas.salesCallLogRowLink_(fakeSheet, 252);
  assert.ok(link.indexOf(gas.SALES_CALL_LOG_SPREADSHEET_ID) !== -1);
  assert.ok(link.indexOf('gid=987654321') !== -1);
  assert.ok(link.indexOf('range=A252') !== -1);
});

test('sendRandomCalibrationDigest_ formats with bold names and both a transcript link and a sheet-row link (Kris\'s ask 29/08/2026: "Bad formatting. No bold. Add the links!")', () => {
  const sample = [
    { rowIndex: 252, rep: 'Sean', prospectName: 'William Schlunaker', transcriptUrl: 'https://docs.google.com/document/d/abc123/edit' },
    { rowIndex: 72, rep: 'Tomás', prospectName: 'Tennitia Wilson', transcriptUrl: '' }
  ];
  const fakeSheet = { getSheetId: () => 111 };
  const logs = [];
  const originalLogger = gas.Logger;
  const originalEnabled = gas.RANDOM_CALIBRATION_CONFIG.ENABLED;
  gas.Logger = { log: (msg) => logs.push(msg) };
  gas.RANDOM_CALIBRATION_CONFIG.ENABLED = false; // preview path: logs the plain body instead of sending
  try {
    gas.sendRandomCalibrationDigest_(sample, false, fakeSheet);
  } finally {
    gas.Logger = originalLogger;
    gas.RANDOM_CALIBRATION_CONFIG.ENABLED = originalEnabled;
  }
  const joined = logs.join('\n');
  assert.ok(joined.indexOf('William Schlunaker') !== -1);
  assert.ok(joined.indexOf('https://docs.google.com/document/d/abc123/edit') !== -1, 'expected the transcript link in the logged preview');
  assert.ok(joined.indexOf('range=A252') !== -1, 'expected the sheet-row link in the logged preview');
});

test('sendRandomCalibrationDigest_\'s live send includes an htmlBody with bold names and clickable links, and handles a missing transcript URL without a broken link', () => {
  const sample = [
    { rowIndex: 455, rep: 'Bens', prospectName: 'William Holder', transcriptUrl: 'https://docs.google.com/document/d/xyz789/edit' },
    { rowIndex: 193, rep: 'Sean', prospectName: 'Margaret Bruno', transcriptUrl: '' }
  ];
  const fakeSheet = { getSheetId: () => 222 };
  let captured = null;
  const originalGuardedSend = gas.guardedSend_;
  const originalEnabled = gas.RANDOM_CALIBRATION_CONFIG.ENABLED;
  gas.guardedSend_ = (to, subject, body, options) => { captured = { to, subject, body, options }; return true; };
  gas.RANDOM_CALIBRATION_CONFIG.ENABLED = true;
  try {
    gas.sendRandomCalibrationDigest_(sample, false, fakeSheet);
  } finally {
    gas.guardedSend_ = originalGuardedSend;
    gas.RANDOM_CALIBRATION_CONFIG.ENABLED = originalEnabled;
  }
  assert.ok(captured, 'expected guardedSend_ to be called');
  assert.ok(captured.options.htmlBody, 'expected an htmlBody');
  assert.ok(captured.options.htmlBody.indexOf('<strong>William Holder</strong>') !== -1);
  assert.ok(captured.options.htmlBody.indexOf('href="https://docs.google.com/document/d/xyz789/edit"') !== -1);
  assert.ok(captured.options.htmlBody.indexOf('no transcript on file') !== -1, 'expected a graceful fallback for the row with no transcript');
});

// ---------------------------------------------------------------------------
// Conversion funnel report (Phase10_ConversionFunnel.gs) — Kris's ask
// (04/09/2026): weekly, per rep, QC booked -> attended -> qualified ->
// Sales Call booked -> attended -> Sold, plus Tomás's own closing-call
// section, across this week / last 30 days / last 90 days.
// ---------------------------------------------------------------------------

test('isQcCallTypeForFunnel_ / isSalesCallTypeForFunnel_ match case/whitespace-insensitively, exclude Discovery from the Sales Call step', () => {
  assert.equal(gas.isQcCallTypeForFunnel_('QC'), true);
  assert.equal(gas.isQcCallTypeForFunnel_(' qc '), true);
  assert.equal(gas.isQcCallTypeForFunnel_('Sales Call'), false);
  assert.equal(gas.isSalesCallTypeForFunnel_('Sales Call'), true);
  assert.equal(gas.isSalesCallTypeForFunnel_('sales call'), true);
  assert.equal(gas.isSalesCallTypeForFunnel_('Discovery'), false, 'Discovery is the AM post-sale call, not a step in this funnel');
  assert.equal(gas.isSalesCallTypeForFunnel_('QC'), false);
});

test('attendedForFunnel_ is false only for an explicit "No-show", true for blank (not yet known)', () => {
  assert.equal(gas.attendedForFunnel_('No-show'), false);
  assert.equal(gas.attendedForFunnel_('no-show'), false);
  assert.equal(gas.attendedForFunnel_('Sold'), true);
  assert.equal(gas.attendedForFunnel_(''), true);
  assert.equal(gas.attendedForFunnel_(null), true);
});

test('safeRateForFunnel_ / formatFunnelRate_ report null (not 0 or a throw) on a zero denominator', () => {
  assert.equal(gas.safeRateForFunnel_(3, 0), null);
  assert.equal(gas.safeRateForFunnel_(3, 6), 0.5);
  assert.equal(gas.formatFunnelRate_(0, 0), '0/0 (n/a)');
  assert.equal(gas.formatFunnelRate_(1, 4), '1/4 (25%)');
});

test('matchLaterSalesCallForFunnel_ picks the EARLIEST Sales Call after the QC date, ignores earlier ones, matches name case/punctuation-insensitively', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const qcDate = bizDate(gas, 2026, 8, 10);
  const rows = [
    { prospectName: 'Andrew Coppens', callDate: bizDate(gas, 2026, 8, 5), outcomeDisposition: 'Sold' }, // before the QC -- must be ignored
    { prospectName: 'ANDREW  Coppens.', callDate: bizDate(gas, 2026, 8, 20), outcomeDisposition: 'Not Sold' }, // later, but not the earliest
    { prospectName: 'andrew coppens', callDate: bizDate(gas, 2026, 8, 12), outcomeDisposition: 'Sold' }, // the real match: earliest after the QC
    { prospectName: 'A Different Person', callDate: bizDate(gas, 2026, 8, 11), outcomeDisposition: 'Sold' }
  ];
  const match = gas.matchLaterSalesCallForFunnel_(rows, 'Andrew Coppens', qcDate);
  assert.ok(match);
  assert.equal(realFormatDate(match.callDate, 'America/New_York', 'yyyy/MM/dd'), '2026/08/12');
});

test('matchLaterSalesCallForFunnel_ returns null when nothing matches (no name match, or nothing after the date)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const qcDate = bizDate(gas, 2026, 8, 10);
  assert.equal(gas.matchLaterSalesCallForFunnel_([], 'Andrew Coppens', qcDate), null);
  assert.equal(gas.matchLaterSalesCallForFunnel_(
    [{ prospectName: 'Someone Else', callDate: bizDate(gas, 2026, 8, 15), outcomeDisposition: 'Sold' }],
    'Andrew Coppens', qcDate
  ), null);
  assert.equal(gas.matchLaterSalesCallForFunnel_(
    [{ prospectName: 'Andrew Coppens', callDate: bizDate(gas, 2026, 8, 1), outcomeDisposition: 'Sold' }],
    'Andrew Coppens', qcDate
  ), null, 'a Sales Call before the QC date must never count as what the QC produced');
});

function funnelRow(gas, { rep, prospectName, callType, callDate, outcomeDisposition, leadQualityVerdict }) {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const row = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  row[col['Rep'] - 1] = rep;
  row[col['Prospect Name'] - 1] = prospectName;
  row[col['Call Type'] - 1] = callType;
  row[col['Call Date'] - 1] = callDate;
  row[col['Outcome Disposition'] - 1] = outcomeDisposition || '';
  row[col['Lead Quality Verdict'] - 1] = leadQualityVerdict || '';
  return row;
}

test('computeConversionFunnelWindow_ builds the real end-to-end funnel: a booked, attended, qualified QC that produced a later Sales Call, sold — attributed to the QC rep even though a different rep closed it', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const windowStart = bizDate(gas, 2026, 8, 1);
  const windowEnd = bizDate(gas, 2026, 8, 31);
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });

  const rows = [
    funnelRow(gas, { rep: 'Bens', prospectName: 'Andrew Coppens', callType: 'QC', callDate: bizDate(gas, 2026, 8, 10), outcomeDisposition: '', leadQualityVerdict: 'good_to_book' }),
    funnelRow(gas, { rep: 'Bens', prospectName: 'No Show Lead', callType: 'QC', callDate: bizDate(gas, 2026, 8, 11), outcomeDisposition: 'No-show', leadQualityVerdict: '' }),
    funnelRow(gas, { rep: 'Bens', prospectName: 'Screened Out Lead', callType: 'QC', callDate: bizDate(gas, 2026, 8, 12), outcomeDisposition: '', leadQualityVerdict: 'should_screen_out' }),
    // Closed by Tomás, not Bens -- must still attribute to Bens's funnel (rep-agnostic match) AND count in Tomás's own section.
    funnelRow(gas, { rep: 'Tomás', prospectName: 'Andrew Coppens', callType: 'Sales Call', callDate: bizDate(gas, 2026, 8, 15), outcomeDisposition: 'Sold' })
  ];

  const result = gas.computeConversionFunnelWindow_(rows, col, ['Bens', 'Sean', 'Joana'], windowStart, windowEnd);
  const bens = result.byRep.Bens;
  assert.equal(bens.qcBooked, 3);
  assert.equal(bens.qcAttended, 2, 'the No-show QC must not count as attended');
  assert.equal(bens.qcQualified, 1, 'only the good_to_book, attended QC counts as qualified');
  assert.equal(bens.scBooked, 1, 'the qualified QC must be matched to its later Sales Call, whoever closed it');
  assert.equal(bens.scAttended, 1);
  assert.equal(bens.sold, 1);

  assert.equal(result.tomas.booked, 1, 'Tomás\'s own section counts the same Sales Call independently');
  assert.equal(result.tomas.attended, 1);
  assert.equal(result.tomas.sold, 1);

  assert.equal(result.byRep.Sean.qcBooked, 0);
  assert.equal(result.byRep.Joana.qcBooked, 0);
});

test('computeConversionFunnelWindow_ excludes rows outside the window and non-QC/non-Sales-Call Call Types (e.g. Discovery)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const windowStart = bizDate(gas, 2026, 8, 1);
  const windowEnd = bizDate(gas, 2026, 8, 31);
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });

  const rows = [
    funnelRow(gas, { rep: 'Bens', prospectName: 'Outside Window', callType: 'QC', callDate: bizDate(gas, 2026, 7, 15), leadQualityVerdict: 'good_to_book' }),
    funnelRow(gas, { rep: 'Bens', prospectName: 'A Discovery Call', callType: 'Discovery', callDate: bizDate(gas, 2026, 8, 5) })
  ];
  const result = gas.computeConversionFunnelWindow_(rows, col, ['Bens', 'Sean', 'Joana'], windowStart, windowEnd);
  assert.equal(result.byRep.Bens.qcBooked, 0);
});

test('buildConversionFunnelEmail_ renders every rep and the Tomás section, with week/30d/90d numbers all present', () => {
  const emptyRep = { qcBooked: 0, qcAttended: 0, qcQualified: 0, scBooked: 0, scAttended: 0, sold: 0 };
  const bensWeek = { qcBooked: 3, qcAttended: 2, qcQualified: 1, scBooked: 1, scAttended: 1, sold: 1 };
  const windows = {
    week: { byRep: { Bens: bensWeek, Sean: emptyRep, Joana: emptyRep }, tomas: { booked: 1, attended: 1, sold: 1 } },
    month: { byRep: { Bens: emptyRep, Sean: emptyRep, Joana: emptyRep }, tomas: { booked: 0, attended: 0, sold: 0 } },
    quarter: { byRep: { Bens: emptyRep, Sean: emptyRep, Joana: emptyRep }, tomas: { booked: 0, attended: 0, sold: 0 } }
  };
  const email = gas.buildConversionFunnelEmail_(['Bens', 'Sean', 'Joana'], windows, '24/08–30/08/2026');
  assert.ok(email.subject.indexOf('Conversion Funnel') !== -1);
  assert.ok(email.body.indexOf('Bens:') !== -1 && email.body.indexOf('Sean:') !== -1 && email.body.indexOf('Joana:') !== -1);
  assert.ok(email.body.indexOf('Tomás') !== -1);
  assert.ok(email.body.indexOf('3') !== -1 && email.body.indexOf('last 30d') !== -1 && email.body.indexOf('last 90d') !== -1);
  assert.ok(email.body.indexOf('Bens specifically') !== -1, 'the incomplete-data caveat for Bens must be present');
});

// ---------------------------------------------------------------------------
// Phase 11 — Bens Podcast Tracker -> Sales Call Log sync
// ---------------------------------------------------------------------------

function bensTrackerCol(gas) {
  const col = {};
  gas.BENS_PODCAST_TRACKER_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  return col;
}

function bensTrackerRow(gas, overrides) {
  const row = new Array(gas.BENS_PODCAST_TRACKER_HEADERS.length).fill('');
  Object.keys(overrides).forEach((h) => { row[gas.BENS_PODCAST_TRACKER_HEADERS.indexOf(h)] = overrides[h]; });
  return row;
}

function bensLogCol(gas) {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  return col;
}

test('computeBensPodcastSyncPlan_ creates a Sales Call Log row for a tracker row with Recording Done checked and no existing synced row', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [
    bensTrackerRow(gas, { Name: 'Joey Lamielle', Email: 'joey@example.com', Source: 'Referral', 'Recording Date': '26/08/2026', 'Recording Done': true })
  ];
  const lCol = bensLogCol(gas);
  const plan = gas.computeBensPodcastSyncPlan_(trackerRows, tCol, [], lCol);
  assert.equal(plan.toCreate.length, 1);
  assert.equal(plan.toCreate[0].prospectName, 'Joey Lamielle');
  assert.equal(plan.toCreate[0].prospectEmail, 'joey@example.com');
  assert.equal(plan.toCreate[0].callDate, '26/08/2026');
  assert.equal(plan.stats.notRecordingDone, 0);
});

test('computeBensPodcastSyncPlan_ skips a tracker row whose Recording Done is not yet checked, rather than syncing it early', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [
    bensTrackerRow(gas, { Name: 'Darlene Teeter', 'Recording Date': '31/08/2026', 'Recording Done': false })
  ];
  const lCol = bensLogCol(gas);
  const plan = gas.computeBensPodcastSyncPlan_(trackerRows, tCol, [], lCol);
  assert.equal(plan.toCreate.length, 0);
  assert.equal(plan.stats.notRecordingDone, 1);
});

test('computeBensPodcastSyncPlan_ does NOT create a duplicate row when a matching Bens/"Icons 100 Recording" row already exists in Sales Call Log', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [
    bensTrackerRow(gas, { Name: 'Mark Ryan', 'Recording Date': '31/08/2026', 'Recording Done': true })
  ];
  const lCol = bensLogCol(gas);
  const existingLogRows = [
    gas.SALES_CALL_LOG_HEADERS.map(() => '')
  ];
  existingLogRows[0][lCol['Prospect Name'] - 1] = 'Mark Ryan';
  existingLogRows[0][lCol['Rep'] - 1] = 'Bens';
  existingLogRows[0][lCol['Call Type'] - 1] = 'Icons 100 Recording';
  const plan = gas.computeBensPodcastSyncPlan_(trackerRows, tCol, existingLogRows, lCol);
  assert.equal(plan.toCreate.length, 0);
  assert.equal(plan.stats.alreadySynced, 1);
});

test('computeBensPodcastSyncPlan_ falls back to Booking Date when Recording Date is blank', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [
    bensTrackerRow(gas, { Name: 'Tammy DeWolfe', 'Booking Date': '01/09/2026', 'Recording Date': '', 'Recording Done': true })
  ];
  const lCol = bensLogCol(gas);
  const plan = gas.computeBensPodcastSyncPlan_(trackerRows, tCol, [], lCol);
  assert.equal(plan.toCreate.length, 1);
  assert.equal(plan.toCreate[0].callDate, '01/09/2026');
});

test('computeBensPodcastSyncPlan_ skips a tracker row with Recording Done checked but no Name, rather than creating an unidentifiable row', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [
    bensTrackerRow(gas, { Name: '', 'Recording Date': '01/09/2026', 'Recording Done': true })
  ];
  const lCol = bensLogCol(gas);
  const plan = gas.computeBensPodcastSyncPlan_(trackerRows, tCol, [], lCol);
  assert.equal(plan.toCreate.length, 0);
  assert.equal(plan.stats.missingName, 1);
});

test('isSalesCallTypeForScorecard_ excludes "Icons 100 Recording" rows from sales-coaching stats, same as QC/Discovery (Tomas: outcome is not Bens\'s to be scored on)', () => {
  assert.equal(gas.isSalesCallTypeForScorecard_('Icons 100 Recording'), false);
  assert.equal(gas.isSalesCallTypeForScorecard_('icons 100 recording'), false);
  assert.equal(gas.isSalesCallTypeForScorecard_('Sales Call'), true);
});

test('getValidatedBensTrackerColumnMap_ tolerates the real tracker\'s stray trailing space on "SC Booked " rather than throwing header-drift', () => {
  const headerRow = gas.BENS_PODCAST_TRACKER_HEADERS.slice();
  headerRow[headerRow.indexOf('SC Booked')] = 'SC Booked ';
  const sheet = { getRange: () => ({ getValues: () => [headerRow] }) };
  const col = gas.getValidatedBensTrackerColumnMap_(sheet);
  assert.equal(col['SC Booked'], headerRow.indexOf('SC Booked ') + 1);
});

test('formatBensSyncDateForLog_ renders a Date in business timezone dd/MM/yyyy, not the script default timezone\'s toString()', () => {
  const d = new gas.Date(Date.UTC(2026, 4, 18, 0, 0, 0));
  assert.equal(gas.formatBensSyncDateForLog_(d), realFormatDate(d, 'America/New_York', 'dd/MM/yyyy'));
});

test('formatBensSyncDateForLog_ passes through a non-Date value (e.g. a blank Booking Date fallback) as-is', () => {
  assert.equal(gas.formatBensSyncDateForLog_(''), '(blank)');
  assert.equal(gas.formatBensSyncDateForLog_('31/08/2026'), '31/08/2026');
});

// ---------------------------------------------------------------------------
// Consolidated ongoing scoring (04/09/2026) — freed 4 trigger slots for
// Phase 11's Bens podcast sync trigger after the project hit Apps Script's
// 20-trigger cap.
// ---------------------------------------------------------------------------

test('shouldSkipRemainingScoringPasses_ is false within budget and true once elapsed time exceeds it', () => {
  assert.equal(gas.shouldSkipRemainingScoringPasses_(1000, 1000 + 5 * 60 * 1000, 20 * 60 * 1000), false);
  assert.equal(gas.shouldSkipRemainingScoringPasses_(1000, 1000 + 25 * 60 * 1000, 20 * 60 * 1000), true);
  assert.equal(gas.shouldSkipRemainingScoringPasses_(1000, 1000 + 20 * 60 * 1000, 20 * 60 * 1000), false, 'exactly at budget must not skip yet — only strictly over');
});

test('shouldStopRescorePass_ refuses to start a row that could plausibly blow through the real 6-minute ceiling, not just once the flat budget is already spent', () => {
  const BUDGET = 5 * 60 * 1000, CEILING = 6 * 60 * 1000, DEFAULT_EST = 4 * 60 * 1000, MARGIN = 20 * 1000;

  // Real near-miss, live 08/09/2026: row 1 took 194s. At that point the OLD
  // flat check (194s < 300s budget) let row 2 start, and the pass finished
  // at 357s — 3 SECONDS under the real 360s ceiling. Using row 1's own
  // duration as the estimate for row 2, starting it is 194s + (194s + 20s)
  // = 408s, well past the 360s ceiling — this must now say STOP.
  assert.equal(
    gas.shouldStopRescorePass_(194 * 1000, BUDGET, 194 * 1000, CEILING, DEFAULT_EST, MARGIN),
    true,
    'must stop before a row whose own precedent this pass makes another blow the ceiling'
  );

  // Comfortably early, no rows completed yet (slowestRowMs=0) — the
  // conservative default estimate still leaves headroom, so it's fine to go.
  assert.equal(gas.shouldStopRescorePass_(10 * 1000, BUDGET, 0, CEILING, DEFAULT_EST, MARGIN), false);

  // A genuinely fast row (say 30s) must not force an early stop just
  // because the flat budget was already the only signal before this fix —
  // the estimate should let several fast rows run back-to-back.
  assert.equal(gas.shouldStopRescorePass_(60 * 1000, BUDGET, 30 * 1000, CEILING, DEFAULT_EST, MARGIN), false);

  // The pre-existing flat-budget stop must still fire on its own, even if
  // every row so far has been fast (a permanently-slow LATER row is not
  // knowable in advance, so the flat budget stays as a backstop).
  assert.equal(gas.shouldStopRescorePass_(BUDGET + 1, BUDGET, 1000, CEILING, DEFAULT_EST, MARGIN), true);

  // Strictly under the flat budget with a real (small) slowest-row estimate
  // must not stop yet, unlike the "exactly at budget" case above — this one
  // isolates the flat-budget comparison from the ceiling comparison, which
  // is a SEPARATE constraint now and can independently say stop even when
  // the flat budget alone would not (below: elapsed 250s + budget 300s -> ok
  // by the flat check; small slowestRowMs keeps the ceiling check clear too).
  assert.equal(gas.shouldStopRescorePass_(250 * 1000, BUDGET, 30 * 1000, CEILING, DEFAULT_EST, MARGIN), false);
});

test('the ACTUAL global rescore constants correctly handle both real 08/09/2026 incidents: the 357s near-miss, and the 739s Workspace-account run that proved 6 minutes was the wrong ceiling', () => {
  // Incident 1 (why the estimate-based check exists): row 1 took 194s.
  // Against the retuned globals it must still be fine to keep going — a
  // single 194s row is nowhere near either real limit now.
  assert.equal(gas.shouldStopRescorePass_(
    194 * 1000, gas.RESCORE_ALL_TIME_BUDGET_MS_, 194 * 1000,
    gas.RESCORE_HARD_EXECUTION_CEILING_MS_, gas.RESCORE_ROW_DURATION_DEFAULT_ESTIMATE_MS_,
    gas.RESCORE_ROW_OVERHEAD_SAFETY_MARGIN_MS_
  ), false, 'a 194s row is real Workspace-account behavior, not a reason to stop');

  // Incident 2: row 2 (Stacie Staub) took 669s after one transport-timeout
  // retry, landing the whole pass at 739s total — and the execution
  // completed normally. The retuned globals must agree it was safe to
  // have kept going for a 3rd row from there.
  assert.equal(gas.shouldStopRescorePass_(
    739 * 1000, gas.RESCORE_ALL_TIME_BUDGET_MS_, 669 * 1000,
    gas.RESCORE_HARD_EXECUTION_CEILING_MS_, gas.RESCORE_ROW_DURATION_DEFAULT_ESTIMATE_MS_,
    gas.RESCORE_ROW_OVERHEAD_SAFETY_MARGIN_MS_
  ), false, '739s total with a 669s worst row so far must still allow one more attempt');

  // But the ceiling must still mean something: a row bad enough to make
  // the NEXT one plausibly exceed the real ~30-minute Workspace limit must
  // still stop the pass, not let it ride indefinitely.
  assert.equal(gas.shouldStopRescorePass_(
    20 * 60 * 1000, gas.RESCORE_ALL_TIME_BUDGET_MS_, 15 * 60 * 1000,
    gas.RESCORE_HARD_EXECUTION_CEILING_MS_, gas.RESCORE_ROW_DURATION_DEFAULT_ESTIMATE_MS_,
    gas.RESCORE_ROW_OVERHEAD_SAFETY_MARGIN_MS_
  ), true, 'a 15-minute row seen once must still be treated as a real risk for the next one');
});

test('rescoreAllCalls_ (live) still lets a slow-but-real row (669s, the second real incident) through, now that the ceiling reflects this Workspace account\'s actual ~30-minute limit', () => {
  const col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach((h, i) => { col[h] = i + 1; });
  const dataRows = [
    fakeSalesCallLogRow({
      'Prospect Name': 'Slow Row', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    }),
    fakeSalesCallLogRow({
      'Prospect Name': 'Row Two', Rep: 'Joana', 'Call Type': 'QC', 'Match Method': 'exact_key',
      'Transcript URL': 'https://docs.google.com/document/d/1KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK/edit',
      'Call Quality Score': 3, 'Rubric Version': '2026-08-01-old', 'Kris Manual Review Verdict': ''
    })
  ];
  const sheet = fakeSalesCallLogSheetForRescore(dataRows);

  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalDriveApp = gas.DriveApp;
  const originalLockService = gas.LockService;
  const originalScoreQc = gas.scoreQcTranscript_;
  const originalLog = gas.Logger.log;
  const originalDateNow = Date.now;
  const lines = [];
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.DriveApp = { getFileById: () => ({ getName: () => 'Fake Prospect.mp4 — Transcript', getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => FAKE_TRANSCRIPT_ }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.Logger.log = (msg) => lines.push(msg);

    // Simulate row 1 actually taking 669s of wall-clock time — the exact
    // real duration of the Stacie Staub row (one Moonshot transport-timeout
    // retry, then a slow success), which is what forced the constants fix
    // in the first place — without the test really sleeping 669 seconds.
    // Date.now() is monkeypatched to jump forward the instant the fake
    // scorer is called (i.e. exactly where the real model call would have
    // consumed that time), then holds steady, so the loop's OWN post-row
    // elapsed/duration math sees the same numbers the real run did.
    let simulatedNow = 1000000;
    gas.Date.now = () => simulatedNow;
    Date.now = () => simulatedNow;
    gas.scoreQcTranscript_ = () => {
      simulatedNow += 669 * 1000;
      return {
        reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
        flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true },
        framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true, framework_matched_to_lead: true },
        delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
        primary_failure_mode: 'none', root_cause_if_no_booking: 'N/A', manual_review_recommended: false, severity: 1,
        feedback_summary: 'rescored'
      };
    };

    gas.rescoreAllCalls_(false);

    const joined = lines.join('\n');
    assert.match(joined, /\[1\/2\] Done: row \d+ \(Slow Row\)/, 'row 1 must complete normally');
    // 669s elapsed + a 669s+20s estimate for row 2 = 1358s, still under the
    // real 1500s (25-min) ceiling — this row must be allowed to run. Under
    // the OLD, wrongly-conservative 6-minute assumption this would have
    // been refused (exactly the over-caution Kris was pushing back on:
    // the point of retuning the constants was to stop losing rows the
    // account can actually still finish).
    assert.match(joined, /Rescoring row \d+ \(Row Two/,
      'row 2 must be allowed to start — 669s is real Workspace-account behavior, not a reason to stop early');
    assert.equal(/time budget hit/.test(joined), false, 'both rows should complete in one pass now');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.DriveApp = originalDriveApp;
    gas.LockService = originalLockService;
    gas.scoreQcTranscript_ = originalScoreQc;
    gas.Logger.log = originalLog;
    gas.Date.now = originalDateNow;
    Date.now = originalDateNow;
  }
});

test('runAllOngoingScoringPasses_ calls all 5 passes, Bens last, and one pass throwing does not stop the rest', () => {
  const order = [];
  const originals = {};
  ['scoreNewlyLoggedCalls_', 'scoreJoanaTranscripts', 'scoreSeanTranscripts', 'scoreTomasTranscripts', 'scoreBensLegacyTranscripts'].forEach((name) => {
    originals[name] = gas[name];
    gas[name] = () => {
      order.push(name);
      if (name === 'scoreSeanTranscripts') throw new Error('simulated Sean pass failure');
    };
  });
  const originalOpsAlert = gas.sendOpsAlert_;
  gas.sendOpsAlert_ = () => {};
  try {
    gas.runAllOngoingScoringPasses_();
    assert.deepEqual(order, ['scoreNewlyLoggedCalls_', 'scoreJoanaTranscripts', 'scoreSeanTranscripts', 'scoreTomasTranscripts', 'scoreBensLegacyTranscripts']);
  } finally {
    Object.keys(originals).forEach((name) => { gas[name] = originals[name]; });
    gas.sendOpsAlert_ = originalOpsAlert;
  }
});

test('installOngoingScoringTrigger removes all 5 old per-pass triggers and any prior copy of its own, installing exactly one combined trigger', () => {
  const originalScriptApp = gas.ScriptApp;
  try {
    gas.ScriptApp = fakeScriptAppTriggers_(['scoreNewlyLoggedCalls_', 'scoreSeanTranscripts', 'scoreJoanaTranscripts',
      'scoreTomasTranscripts', 'scoreBensLegacyTranscripts', 'runAllOngoingScoringPasses_', 'someUnrelatedHandler_']);
    gas.installOngoingScoringTrigger();
    const handlerNames = gas.ScriptApp._triggers.map((t) => t.getHandlerFunction());
    assert.deepEqual(handlerNames.filter((h) => h === 'runAllOngoingScoringPasses_').length, 1);
    ['scoreNewlyLoggedCalls_', 'scoreSeanTranscripts', 'scoreJoanaTranscripts', 'scoreTomasTranscripts', 'scoreBensLegacyTranscripts'].forEach((h) => {
      assert.ok(handlerNames.indexOf(h) === -1, h + ' must be removed by the consolidated installer');
    });
    assert.ok(handlerNames.indexOf('someUnrelatedHandler_') !== -1, 'must not touch unrelated triggers');
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

test('STANDING_AUTOMATION_HANDLERS_ reflects the 04/09/2026 consolidation: old per-pass handlers gone, new combined + Bens sync handlers present (a handler missing here gets silently swept as an orphan by installAllReadyTriggers_)', () => {
  ['scoreNewlyLoggedCalls_', 'scoreSeanTranscripts', 'scoreJoanaTranscripts', 'scoreTomasTranscripts', 'scoreBensLegacyTranscripts'].forEach((h) => {
    assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf(h) === -1,
      h + ' was consolidated into runAllOngoingScoringPasses_ and must not remain a separately-recognized standing handler');
  });
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runEvery4HourStandingChecks_') !== -1,
    'runAllOngoingScoringPasses_ was further merged into runEvery4HourStandingChecks_ (11/09/2026)');
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runBensPodcastSync_') !== -1);
});

test('buildComplianceEmail_ names the tab right next to the Tracker link, not just a bare "Tracker:" (real confusion found live 04/09/2026: Tomás opened the shared multi-tab spreadsheet by hand, landed on Bens\' tab by default, and had no way from the email alone to tell if the link itself was pointing at the right tab)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const backlog = [
    { eventId: 'evt-1', title: 'QC / Nicole Freed', prospectGuess: 'Nicole Freed', callDateLabel: '20/08/2026', time: '09:00', firstFlaggedAt: '2026-08-20T22:00:00.000Z' }
  ];

  const repCfg = { name: 'Sean', email: 'sean@iconsofrealestate.com', spreadsheetId: 'SHEET_ID', sheetName: 'Sales Call Log' };
  const email = gas.buildComplianceEmail_(repCfg, backlog, gas.CONFIG.BUSINESS_TIMEZONE, 12345);
  assert.ok(email.body.indexOf('Tracker (Sales Call Log tab): https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=12345') !== -1,
    'plain body must name the tab right next to the link');
  assert.ok(email.htmlBody.indexOf('<b>Tracker (Sales Call Log tab):</b>') !== -1,
    'html body must name the tab right next to the link');

  // repCfg.sheetName omitted must not print "undefined" -- falls back to the
  // real default tab name every current rep actually uses.
  const repCfgNoSheetName = { name: 'Joana', email: 'joana@iconsofrealestate.com', spreadsheetId: 'SHEET_ID' };
  const emailNoSheetName = gas.buildComplianceEmail_(repCfgNoSheetName, backlog, gas.CONFIG.BUSINESS_TIMEZONE, 12345);
  assert.ok(emailNoSheetName.body.indexOf('Tracker (Sales Call Log tab):') !== -1);
  assert.ok(emailNoSheetName.body.indexOf('undefined') === -1);
});

// ---------------------------------------------------------------------------
// previewGhlNotesAndCustomFields_ (Phase9_GhlSync.gs) — read-only probe for
// whether GHL can hold call fields + review notes at all (04/09/2026,
// Tomás's "ditch the spreadsheets" ask).
// ---------------------------------------------------------------------------

function withMockedGhlNotesProbe_(mocks, fn) {
  const originals = {
    ghlCheckSetup_: gas.ghlCheckSetup_,
    ghlGetLocationCustomFieldDefs_: gas.ghlGetLocationCustomFieldDefs_,
    sampleSalesCallLogRows_: gas.sampleSalesCallLogRows_,
    ghlSearchContactByName_: gas.ghlSearchContactByName_,
    ghlGetContact_: gas.ghlGetContact_,
    ghlGetContactNotes_: gas.ghlGetContactNotes_,
    Logger: gas.Logger
  };
  const lines = [];
  gas.Logger = { log: (msg) => lines.push(msg) };
  gas.ghlCheckSetup_ = () => 'loc-1';
  gas.ghlGetLocationCustomFieldDefs_ = () => ({ ok: true, defs: {}, raw: [] });
  gas.sampleSalesCallLogRows_ = () => [{ prospectName: 'Nicole Freed', rep: 'Bens' }];
  gas.ghlSearchContactByName_ = () => ({ ok: true, contacts: [{ id: 'c-1', name: 'Nicole Freed' }] });
  Object.assign(gas, mocks);
  try {
    fn(lines);
  } finally {
    Object.assign(gas, originals);
  }
}

test('previewGhlNotesAndCustomFields_ lists every custom field DEFINITION configured on the location, and resolves a contact\'s opaque field IDs to their real names', () => {
  withMockedGhlNotesProbe_({
    ghlGetLocationCustomFieldDefs_: () => ({
      ok: true,
      defs: { 'fld-1': { id: 'fld-1', name: 'Call Date', dataType: 'DATE' } },
      raw: [{ id: 'fld-1', name: 'Call Date', model: 'contact', dataType: 'DATE' }]
    }),
    ghlGetContact_: () => ({ ok: true, contact: { customFields: [{ id: 'fld-1', value: '20/08/2026' }] } }),
    ghlGetContactNotes_: () => ({ ok: true, notes: [] })
  }, (lines) => {
    gas.previewGhlNotesAndCustomFields_();
    assert.ok(lines.some((l) => l.indexOf('1 custom field DEFINITION(s)') !== -1));
    assert.ok(lines.some((l) => l.indexOf('"Call Date"') !== -1), 'location-level definition listing must show the real name');
    assert.ok(lines.some((l) => l.indexOf('Call Date = "20/08/2026"') !== -1),
      'a contact\'s raw {id, value} pair must be resolved to its real field name, not left as the opaque ID');
  });
});

test('previewGhlNotesAndCustomFields_ reports NO custom fields plainly rather than crashing on an empty/missing customFields shape', () => {
  withMockedGhlNotesProbe_({
    ghlGetContact_: () => ({ ok: true, contact: { id: 'c-1', name: 'Nicole Freed' } }),
    ghlGetContactNotes_: () => ({ ok: true, notes: [] })
  }, (lines) => {
    gas.previewGhlNotesAndCustomFields_();
    assert.ok(lines.some((l) => l.indexOf('NO custom fields') !== -1));
  });
});

test('previewGhlNotesAndCustomFields_ checks every confidently-matched contact in the sample for notes, not just the first, and reports the first one that actually has real note content', () => {
  const sample = [
    { prospectName: 'No Notes Guy', rep: 'Sean' },
    { prospectName: 'Has Notes Guy', rep: 'Joana' }
  ];
  const contactsByName = { 'No Notes Guy': { id: 'c-1', name: 'No Notes Guy' }, 'Has Notes Guy': { id: 'c-2', name: 'Has Notes Guy' } };
  withMockedGhlNotesProbe_({
    sampleSalesCallLogRows_: () => sample,
    ghlSearchContactByName_: (locId, name) => ({ ok: true, contacts: [contactsByName[name]] }),
    ghlGetContact_: () => ({ ok: true, contact: { customFields: [] } }),
    ghlGetContactNotes_: (contactId) => contactId === 'c-2'
      ? { ok: true, notes: [{ dateAdded: '2026-08-20', body: 'Discussed pricing' }] }
      : { ok: true, notes: [] }
  }, (lines) => {
    gas.previewGhlNotesAndCustomFields_();
    assert.ok(lines.some((l) => l.indexOf('Checked 2 contact(s)') !== -1));
    assert.ok(lines.some((l) => l.indexOf('"Has Notes Guy" has 1 note(s)') !== -1));
    assert.ok(lines.some((l) => l.indexOf('Discussed pricing') !== -1));
  });
});

test('previewGhlNotesAndCustomFields_ distinguishes "checked, genuinely empty" from "the notes call itself failed"', () => {
  withMockedGhlNotesProbe_({
    ghlGetContact_: () => ({ ok: true, contact: { customFields: [] } }),
    ghlGetContactNotes_: () => ({ ok: true, notes: [] })
  }, (lines) => {
    gas.previewGhlNotesAndCustomFields_();
    assert.ok(lines.some((l) => l.indexOf('None of them have any notes yet') !== -1));
  });

  withMockedGhlNotesProbe_({
    ghlGetContact_: () => ({ ok: true, contact: { customFields: [] } }),
    ghlGetContactNotes_: () => ({ ok: false, status: 404, body: 'not found' })
  }, (lines) => {
    gas.previewGhlNotesAndCustomFields_();
    assert.ok(lines.some((l) => l.indexOf('FAILED for at least one of them: HTTP 404') !== -1));
  });
});

test('previewGhlNotesAndCustomFields_ bails clearly when no confident contact match exists in the sample, rather than probing a wrong/null contact', () => {
  let getContactCalls = 0;
  withMockedGhlNotesProbe_({
    ghlSearchContactByName_: () => ({ ok: true, contacts: [] }),
    ghlGetContact_: () => { getContactCalls++; return { ok: true, contact: {} }; }
  }, (lines) => {
    gas.previewGhlNotesAndCustomFields_();
    assert.equal(getContactCalls, 0);
    assert.ok(lines.some((l) => l.indexOf('Could not find a single confident contact match') !== -1));
  });
});

// ---------------------------------------------------------------------------
// Phase 12 — post each scored call's AI review as a GHL Note
// (Phase12_GhlNoteSync.gs)
// ---------------------------------------------------------------------------

test('buildGhlReviewNoteBody_ includes call date/type/rep, lead quality, score, feedback summary, and a transcript link', () => {
  const body = gas.buildGhlReviewNoteBody_({
    callDate: '20/08/2026',
    callType: 'Sales Call',
    rep: 'Sean',
    leadQualityVerdict: 'Qualified',
    callQualityScore: 4,
    aiFeedbackSummary: 'Handled objections well.',
    transcriptUrl: 'https://drive.google.com/x'
  });
  assert.ok(body.indexOf('20/08/2026') !== -1);
  assert.ok(body.indexOf('Sales Call') !== -1);
  assert.ok(body.indexOf('Sean') !== -1);
  assert.ok(body.indexOf('Qualified') !== -1);
  assert.ok(body.indexOf('4/5') !== -1);
  assert.ok(body.indexOf('Handled objections well.') !== -1);
  assert.ok(body.indexOf('<a href="https://drive.google.com/x">Transcript</a>') !== -1);
});

test('buildGhlReviewNoteBody_ escapes free-text feedback so an untrusted AI summary can never break the note\'s HTML', () => {
  const body = gas.buildGhlReviewNoteBody_({
    callDate: '20/08/2026', callType: 'QC', rep: 'Bens', leadQualityVerdict: 'Qualified',
    callQualityScore: 3, aiFeedbackSummary: '<script>alert(1)</script>', transcriptUrl: ''
  });
  assert.ok(body.indexOf('<script>') === -1);
  assert.ok(body.indexOf('&lt;script&gt;') !== -1);
});

test('buildGhlReviewNoteBody_ shows "(not scored)" for a blank score rather than printing "undefined/5" or "null/5"', () => {
  const body = gas.buildGhlReviewNoteBody_({ callDate: '20/08/2026', callType: 'QC', rep: 'Bens', leadQualityVerdict: 'Qualified', callQualityScore: '', aiFeedbackSummary: '', transcriptUrl: '' });
  assert.ok(body.indexOf('(not scored)/5') === -1);
  assert.ok(body.indexOf('Call Quality Score:</strong> (not scored)') !== -1);
});

test('buildGhlReviewNoteBody_ uses <strong> + <br><br> (both confirmed live to render), never <p> or markdown asterisks (both confirmed live NOT to work: <p> gives no visual gap, and **/* show as literal asterisks — runGhlNoteFormattingTest_, 05/09/2026)', () => {
  const body = gas.buildGhlReviewNoteBody_({
    callDate: '20/08/2026', callType: 'Sales Call', rep: 'Sean',
    leadQualityVerdict: 'Qualified', callQualityScore: 4,
    aiFeedbackSummary: 'Handled objections well.', transcriptUrl: 'https://drive.google.com/x'
  });
  assert.ok(body.indexOf('<p>') === -1 && body.indexOf('</p>') === -1);
  assert.ok(body.indexOf('<strong>') !== -1);
  assert.ok(body.indexOf('<br><br>') !== -1);
  assert.ok(body.indexOf('**') === -1);
});

test('buildGhlReviewNoteBody_ formats a real Date callDate in CONFIG.BUSINESS_TIMEZONE as dd/MM/yyyy (real bug: raw Date.toString() leaked the Apps Script project\'s own timezone into a live, team-visible GHL note)', () => {
  const originalUtilities = gas.Utilities;
  gas.Utilities = { formatDate: realFormatDate };
  try {
    // A moment that renders as a DIFFERENT calendar day in the Apps Script
    // project's own default timezone (Indochina Time, UTC+7) than in
    // CONFIG.BUSINESS_TIMEZONE ('America/New_York') — this is exactly the
    // live bug: the note showed "Wed Jan 21 2026 12:00:00 GMT+0700
    // (Indochina Time)" (Date.toString()'s default rendering) instead of a
    // clean business-timezone date.
    const callDate = new gas.Date(Date.UTC(2026, 0, 21, 0, 30)); // 2026-01-21 00:30 UTC
    const body = gas.buildGhlReviewNoteBody_({
      callDate: callDate, callType: 'Sales Call', rep: 'Sean',
      leadQualityVerdict: 'Qualified', callQualityScore: 4,
      aiFeedbackSummary: '', transcriptUrl: ''
    });
    assert.ok(body.indexOf('GMT') === -1);
    assert.ok(body.indexOf('Indochina') === -1);
    assert.ok(body.indexOf('20/01/2026') !== -1); // still 20 Jan in America/New_York (UTC-5)
  } finally {
    gas.Utilities = originalUtilities;
  }
});

function withMockedGhlNoteSyncPlan_(mocks, fn) {
  const originals = {
    SpreadsheetApp: gas.SpreadsheetApp,
    Utilities: gas.Utilities,
    ghlSearchContactByName_: gas.ghlSearchContactByName_
  };
  gas.Utilities = { sleep: () => {}, formatDate: realFormatDate };
  Object.assign(gas, mocks);
  try {
    return fn();
  } finally {
    Object.assign(gas, originals);
  }
}

function ghlNoteSyncHeaders() {
  return gas.SALES_CALL_LOG_HEADERS.slice();
}

function ghlNoteSyncRow(overrides) {
  const row = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  Object.keys(overrides).forEach((h) => { row[gas.SALES_CALL_LOG_HEADERS.indexOf(h)] = overrides[h]; });
  return row;
}

function fakeGhlNoteSyncSheet(dataRows) {
  const headerRow = ghlNoteSyncHeaders();
  return {
    getLastRow: () => dataRows.length + 1,
    getRange: (row) => {
      if (row === 1) return { getValues: () => [headerRow] };
      return { getValues: () => dataRows };
    }
  };
}

test('computeGhlReviewNoteSyncPlan_ skips a row with no Lead Quality Verdict (not yet scored) without ever calling GHL', () => {
  const dataRows = [ghlNoteSyncRow({ 'Prospect Name': 'Not Scored Guy', 'Lead Quality Verdict': '' })];
  let searchCalls = 0;
  const plan = withMockedGhlNoteSyncPlan_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeGhlNoteSyncSheet(dataRows) }) },
    ghlSearchContactByName_: () => { searchCalls++; return { ok: true, contacts: [] }; }
  }, () => gas.computeGhlReviewNoteSyncPlan_('loc-1'));
  assert.equal(searchCalls, 0);
  assert.equal(plan.stats.notScored, 1);
  assert.equal(plan.toPost.length, 0);
});

test('computeGhlReviewNoteSyncPlan_ skips a row already marked "GHL Review Synced", without ever calling GHL, so the same call never gets a duplicate note', () => {
  const dataRows = [ghlNoteSyncRow({ 'Prospect Name': 'Already Synced Guy', 'Lead Quality Verdict': 'Qualified', 'GHL Review Synced': true })];
  let searchCalls = 0;
  const plan = withMockedGhlNoteSyncPlan_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeGhlNoteSyncSheet(dataRows) }) },
    ghlSearchContactByName_: () => { searchCalls++; return { ok: true, contacts: [] }; }
  }, () => gas.computeGhlReviewNoteSyncPlan_('loc-1'));
  assert.equal(searchCalls, 0);
  assert.equal(plan.stats.alreadySynced, 1);
  assert.equal(plan.toPost.length, 0);
});

test('computeGhlReviewNoteSyncPlan_ plans a note for a scored, not-yet-synced row with exactly one confident GHL contact match', () => {
  const dataRows = [ghlNoteSyncRow({
    'Prospect Name': 'Nicole Freed', 'Call Date': '20/08/2026', 'Call Type': 'Sales Call', Rep: 'Sean',
    'Lead Quality Verdict': 'Qualified', 'Call Quality Score': 4, 'AI Feedback Summary': 'Good call.'
  })];
  const plan = withMockedGhlNoteSyncPlan_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeGhlNoteSyncSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c-1', name: 'Nicole Freed' }] })
  }, () => gas.computeGhlReviewNoteSyncPlan_('loc-1'));
  assert.equal(plan.toPost.length, 1);
  assert.equal(plan.toPost[0].contactId, 'c-1');
  assert.equal(plan.toPost[0].row, 2);
  assert.ok(plan.toPost[0].noteBody.indexOf('Good call.') !== -1);
});

test('computeGhlReviewNoteSyncPlan_ leaves an ambiguous match alone rather than guessing which contact to post the note to', () => {
  const dataRows = [ghlNoteSyncRow({ 'Prospect Name': 'Common Name', 'Lead Quality Verdict': 'Qualified' })];
  const plan = withMockedGhlNoteSyncPlan_({
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeGhlNoteSyncSheet(dataRows) }) },
    ghlSearchContactByName_: () => ({ ok: true, contacts: [{ id: 'c-1', name: 'Common Name' }, { id: 'c-2', name: 'Common Name' }] })
  }, () => gas.computeGhlReviewNoteSyncPlan_('loc-1'));
  assert.equal(plan.stats.ambiguous, 1);
  assert.equal(plan.toPost.length, 0);
});

test('runGhlNoteSync_ refuses to write while GHL_NOTE_SYNC_CONFIG.ENABLED is false', () => {
  const original = gas.GHL_NOTE_SYNC_CONFIG.ENABLED;
  let postCalls = 0;
  const originalPost = gas.ghlPostContactNote_;
  gas.ghlPostContactNote_ = () => { postCalls++; return { ok: true }; };
  try {
    gas.GHL_NOTE_SYNC_CONFIG.ENABLED = false;
    gas.runGhlNoteSync_();
    assert.equal(postCalls, 0);
  } finally {
    gas.GHL_NOTE_SYNC_CONFIG.ENABLED = original;
    gas.ghlPostContactNote_ = originalPost;
  }
});

test('runGhlNoteSync_ posts the note and marks "GHL Review Synced" true on a real write', () => {
  const dataRows = [ghlNoteSyncRow({
    'Prospect Name': 'Nicole Freed', 'Lead Quality Verdict': 'Qualified', 'Call Quality Score': 4
  })];
  const sheet = fakeGhlNoteSyncSheet(dataRows);
  const setValues = [];
  sheet.getRange = (function (orig) {
    return function (row, col, numRows, numCols) {
      if (numRows !== undefined) return orig(row, col, numRows, numCols);
      if (row === 1 && col === undefined) return { getValues: () => [ghlNoteSyncHeaders()] };
      return { setValue: (v) => setValues.push({ row: row, col: col, value: v }) };
    };
  })(sheet.getRange);

  const originalEnabled = gas.GHL_NOTE_SYNC_CONFIG.ENABLED;
  const originalGhlCheckSetup = gas.ghlCheckSetup_;
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalUtilities = gas.Utilities;
  const originalSearch = gas.ghlSearchContactByName_;
  const originalPost = gas.ghlPostContactNote_;
  let postedTo = null;
  try {
    gas.GHL_NOTE_SYNC_CONFIG.ENABLED = true;
    gas.ghlCheckSetup_ = () => 'loc-1';
    gas.Utilities = { sleep: () => {}, formatDate: realFormatDate };
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.ghlSearchContactByName_ = () => ({ ok: true, contacts: [{ id: 'c-1', name: 'Nicole Freed' }] });
    gas.ghlPostContactNote_ = (contactId) => { postedTo = contactId; return { ok: true }; };

    gas.runGhlNoteSync_();

    assert.equal(postedTo, 'c-1');
    const synced = setValues.find((s) => s.col === gas.SALES_CALL_LOG_HEADERS.indexOf('GHL Review Synced') + 1);
    assert.ok(synced, 'GHL Review Synced must be written to');
    assert.equal(synced.value, true);
    assert.equal(synced.row, 2);
  } finally {
    gas.GHL_NOTE_SYNC_CONFIG.ENABLED = originalEnabled;
    gas.ghlCheckSetup_ = originalGhlCheckSetup;
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.Utilities = originalUtilities;
    gas.ghlSearchContactByName_ = originalSearch;
    gas.ghlPostContactNote_ = originalPost;
  }
});

test('STANDING_AUTOMATION_HANDLERS_ recognizes runEvery4HourStandingChecks_, not the standalone runGhlNoteSync_ (Phase 12) it was merged into 11/09/2026 -- a missing handler here gets silently swept as an orphan by installAllReadyTriggers_', () => {
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runEvery4HourStandingChecks_') !== -1);
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runGhlNoteSync_') === -1);
});

test('STANDING_AUTOMATION_HANDLERS_ includes the consolidated runPhase17To19StandingChecks_ handler, not the four individual Phase 17/18/19 handlers (trigger-cap consolidation, 07/09/2026) -- missing here means installAllReadyTriggers_ would both never install it AND sweep it away as an orphan the moment someone installs it by hand', () => {
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runPhase17To19StandingChecks_') !== -1);
  ['runPitchGuideReview', 'runSeanEscalationReport', 'runSeanHandoffDetection', 'runReengagementDigest'].forEach((h) => {
    assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf(h) === -1,
      h + ' must NOT have its own standing-trigger entry anymore -- it runs as one of the passes inside runPhase17To19StandingChecks_');
  });
});

// ---------------------------------------------------------------------------
// callKimiJudge_ rename fallback + LLM Cost Log (05/09/2026, external review:
// "LITELLM_PROXY_URL pointing at api.moonshot.ai... will burn someone
// eventually" + "zero cost/token visibility into Kimi calls")
// ---------------------------------------------------------------------------

function fakePropertiesServiceStore_(store) {
  return { getScriptProperties: () => ({ getProperty: (k) => (store[k] !== undefined ? store[k] : null) }) };
}

test('getScriptSecretWithFallback_ prefers the new property name when both are set', () => {
  const original = gas.PropertiesService;
  try {
    gas.PropertiesService = fakePropertiesServiceStore_({ NEW_NAME: 'new-value', OLD_NAME: 'old-value' });
    assert.equal(gas.getScriptSecretWithFallback_('NEW_NAME', 'OLD_NAME'), 'new-value');
  } finally {
    gas.PropertiesService = original;
  }
});

test('getScriptSecretWithFallback_ falls back to the legacy property name when the new one is not set yet, so renaming PHASE2_CONFIG in code cannot break production before the live Script Properties are renamed too', () => {
  const original = gas.PropertiesService;
  const originalLog = gas.Logger.log;
  const lines = [];
  gas.Logger.log = (msg) => lines.push(msg);
  try {
    gas.PropertiesService = fakePropertiesServiceStore_({ OLD_NAME: 'old-value' });
    assert.equal(gas.getScriptSecretWithFallback_('NEW_NAME', 'OLD_NAME'), 'old-value');
    assert.ok(lines.some((l) => l.indexOf('Using legacy Script Property "OLD_NAME"') !== -1));
  } finally {
    gas.PropertiesService = original;
    gas.Logger.log = originalLog;
  }
});

test('getScriptSecretWithFallback_ throws a clear error naming BOTH property names when neither is set', () => {
  const original = gas.PropertiesService;
  try {
    gas.PropertiesService = fakePropertiesServiceStore_({});
    assert.throws(() => gas.getScriptSecretWithFallback_('NEW_NAME', 'OLD_NAME'), /"NEW_NAME".*"OLD_NAME"/);
  } finally {
    gas.PropertiesService = original;
  }
});

function fakeLlmCostLogSheet_() {
  const appended = [];
  return { appendRow: (row) => appended.push(row), _appended: appended };
}

test('logLlmCallCost_ appends a row with caller/outcome/model/token counts, including cached_tokens when Moonshot reports prompt caching', () => {
  const sheet = fakeLlmCostLogSheet_();
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.logLlmCallCost_('phase2:sean', 'success', { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 900 } });
    assert.equal(sheet._appended.length, 1);
    const row = sheet._appended[0];
    assert.equal(row[1], 'phase2:sean');
    assert.equal(row[2], 'success');
    assert.equal(row[4], 1000);
    assert.equal(row[5], 50);
    assert.equal(row[6], 1050);
    assert.equal(row[7], 900);
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

test('logLlmCallCost_ never throws even if the sheet write itself fails -- a logging bug must not become a scoring outage', () => {
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalLog = gas.Logger.log;
  gas.Logger.log = () => {};
  try {
    gas.SpreadsheetApp = { openById: () => { throw new Error('boom'); } };
    assert.doesNotThrow(() => gas.logLlmCallCost_('phase2:sean', 'success', null));
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.Logger.log = originalLog;
  }
});

test('logLlmCallCost_ creates the "LLM Cost Log" tab with its headers if the tab does not exist yet', () => {
  const sheet = fakeLlmCostLogSheet_();
  let insertedName = null;
  const headerWrites = [];
  sheet.getRange = (r, c, nr, nc) => ({
    setValues: (vals) => { headerWrites.push(vals); return { setFontWeight: () => {} }; }
  });
  sheet.setFrozenRows = () => {};
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  try {
    gas.SpreadsheetApp = {
      openById: () => ({
        getSheetByName: () => null,
        insertSheet: (name) => { insertedName = name; return sheet; }
      })
    };
    gas.logLlmCallCost_('phase2:sean', 'success', null);
    assert.equal(insertedName, 'LLM Cost Log');
    assert.deepEqual(headerWrites[0][0], gas.LLM_COST_LOG_HEADERS);
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

function fakeUrlFetchAppJsonResponse_(status, jsonBody) {
  return {
    fetch: () => ({
      getResponseCode: () => status,
      getContentText: () => JSON.stringify(jsonBody)
    })
  };
}

function withMockedCallKimiJudge_(props, fetchResponse, fn) {
  const originals = {
    PropertiesService: gas.PropertiesService,
    UrlFetchApp: gas.UrlFetchApp,
    SpreadsheetApp: gas.SpreadsheetApp,
    Logger: gas.Logger
  };
  const costLogRows = [];
  const sheet = { appendRow: (row) => costLogRows.push(row) };
  gas.PropertiesService = fakePropertiesServiceStore_(props);
  gas.UrlFetchApp = fetchResponse;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
  gas.Logger = { log: () => {} };
  try {
    return fn(costLogRows);
  } finally {
    Object.assign(gas, originals);
  }
}

test('callKimiJudge_ logs a "success" LLM Cost Log row with real usage tokens and returns the content', () => {
  withMockedCallKimiJudge_(
    { MOONSHOT_API_URL: 'https://api.moonshot.ai/v1/chat/completions', MOONSHOT_API_KEY: 'sk-test' },
    fakeUrlFetchAppJsonResponse_(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }),
    (costLogRows) => {
      const result = gas.callKimiJudge_('system', 'user', 'phase2:sean');
      assert.equal(result, '{"ok":true}');
      assert.equal(costLogRows.length, 1);
      assert.equal(costLogRows[0][1], 'phase2:sean');
      assert.equal(costLogRows[0][2], 'success');
      assert.equal(costLogRows[0][5], 20);
    }
  );
});

test('callKimiJudge_ logs an "empty_content" LLM Cost Log row (capturing usage, e.g. a high completion_tokens burn) and still throws, rather than silently succeeding on a thinking-mode budget burn', () => {
  withMockedCallKimiJudge_(
    { MOONSHOT_API_URL: 'https://api.moonshot.ai/v1/chat/completions', MOONSHOT_API_KEY: 'sk-test' },
    fakeUrlFetchAppJsonResponse_(200, { choices: [{ message: { content: '' } }], usage: { prompt_tokens: 500, completion_tokens: 4000, total_tokens: 4500 } }),
    (costLogRows) => {
      assert.throws(() => gas.callKimiJudge_('system', 'user', 'phase2:sean'), gas.LlmTransportError_);
      assert.equal(costLogRows.length, 1);
      assert.equal(costLogRows[0][2], 'empty_content');
      assert.equal(costLogRows[0][5], 4000, 'the huge completion_tokens count -- the thinking-mode-burn signature -- must still be captured');
    }
  );
});

test('callKimiJudge_ still works when only the LEGACY LITELLM_* Script Properties are set (pre-rename Script Properties, freshly-renamed code)', () => {
  withMockedCallKimiJudge_(
    { LITELLM_PROXY_URL: 'https://api.moonshot.ai/v1/chat/completions', LITELLM_API_KEY: 'sk-test' },
    fakeUrlFetchAppJsonResponse_(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
    () => {
      assert.equal(gas.callKimiJudge_('system', 'user'), '{"ok":true}');
    }
  );
});

test('computeGhlReviewNoteSyncPlan_ logs the scan scope up front, so a normal multi-minute run (one GHL search per row) never looks like a silent hang (real gap found live 05/09/2026, same class of bug already fixed once in computeGhlSyncFixes_)', () => {
  const dataRows = [
    ghlNoteSyncRow({ 'Prospect Name': 'Not Scored Guy', 'Lead Quality Verdict': '' }),
    ghlNoteSyncRow({ 'Prospect Name': 'Already Synced Guy', 'Lead Quality Verdict': 'Qualified', 'GHL Review Synced': true }),
    ghlNoteSyncRow({ 'Prospect Name': 'Needs Scan Guy', 'Lead Quality Verdict': 'Qualified' })
  ];
  const originalLog = gas.Logger.log;
  const lines = [];
  gas.Logger.log = (msg) => lines.push(msg);
  try {
    withMockedGhlNoteSyncPlan_({
      SpreadsheetApp: { openById: () => ({ getSheetByName: () => fakeGhlNoteSyncSheet(dataRows) }) },
      ghlSearchContactByName_: () => ({ ok: true, contacts: [] })
    }, () => gas.computeGhlReviewNoteSyncPlan_('loc-1'));
    assert.ok(lines.some((l) => l.indexOf('1 of 3 row(s) are scored and not yet synced') !== -1),
      'must state the real scan scope up front, before any per-row GHL calls');
  } finally {
    gas.Logger.log = originalLog;
  }
});

// ---------------------------------------------------------------------------
// GHL Note Sync revert (05/09/2026, Kris: "move forward with everything and
// revert back Monday if Tomás doesn't like it" -- GHL has no account-level
// backup/restore API, so this tracks exactly what runGhlNoteSync_ creates
// and gives a precise, targeted undo instead of a generic "backup").
// ---------------------------------------------------------------------------

function fakeGhlNoteSyncLogSheet_(dataRows) {
  const cellWrites = [];
  return {
    appendRow: (row) => dataRows.push(row),
    getLastRow: () => dataRows.length + 1,
    getRange: function (row, col, numRows) {
      if (arguments.length >= 3) {
        if (row === 1) return { setValues: () => ({ setFontWeight: () => {} }) };
        return { getValues: () => dataRows };
      }
      return { setValue: (v) => cellWrites.push({ row: row, col: col, value: v }) };
    },
    setFrozenRows: () => {},
    _cellWrites: cellWrites
  };
}

function ghlNoteSyncLogRow(overrides) {
  const row = new Array(gas.GHL_NOTE_SYNC_LOG_HEADERS.length).fill('');
  row[gas.GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Reverted')] = false;
  Object.keys(overrides).forEach((h) => { row[gas.GHL_NOTE_SYNC_LOG_HEADERS.indexOf(h)] = overrides[h]; });
  return row;
}

test('logGhlNoteSyncEntry_ appends a row with row/prospect/contact/note ids and Reverted=false', () => {
  const dataRows = [];
  const sheet = fakeGhlNoteSyncLogSheet_(dataRows);
  const original = gas.SpreadsheetApp;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.logGhlNoteSyncEntry_(42, 'Nicole Freed', 'contact-1', 'note-1');
    assert.equal(dataRows.length, 1);
    assert.equal(dataRows[0][1], 42);
    assert.equal(dataRows[0][2], 'Nicole Freed');
    assert.equal(dataRows[0][3], 'contact-1');
    assert.equal(dataRows[0][4], 'note-1');
    assert.equal(dataRows[0][5], false);
  } finally {
    gas.SpreadsheetApp = original;
  }
});

test('logGhlNoteSyncEntry_ never throws even if the sheet write fails -- the real GHL write already succeeded and must not be undermined by a logging bug', () => {
  const original = gas.SpreadsheetApp;
  try {
    gas.SpreadsheetApp = { openById: () => { throw new Error('boom'); } };
    assert.doesNotThrow(() => gas.logGhlNoteSyncEntry_(1, 'X', 'c', 'n'));
  } finally {
    gas.SpreadsheetApp = original;
  }
});

test('readGhlNoteSyncLogEntries_ parses rows into objects and respects the Reverted flag', () => {
  const dataRows = [
    ghlNoteSyncLogRow({ Row: 5, 'Prospect Name': 'A', 'Contact ID': 'c-1', 'Note ID': 'n-1' }),
    ghlNoteSyncLogRow({ Row: 6, 'Prospect Name': 'B', 'Contact ID': 'c-2', 'Note ID': 'n-2', Reverted: true })
  ];
  const sheet = fakeGhlNoteSyncLogSheet_(dataRows);
  const original = gas.SpreadsheetApp;
  try {
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    const entries = gas.readGhlNoteSyncLogEntries_();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].row, 5);
    assert.equal(entries[0].reverted, false);
    assert.equal(entries[1].row, 6);
    assert.equal(entries[1].reverted, true);
  } finally {
    gas.SpreadsheetApp = original;
  }
});

function withMockedGhlRevert_(dataRows, salesCallLogRows, mocks, fn) {
  const originals = {
    SpreadsheetApp: gas.SpreadsheetApp,
    ghlDeleteContactNote_: gas.ghlDeleteContactNote_
  };
  const logSheet = fakeGhlNoteSyncLogSheet_(dataRows);
  const salesSheet = fakeGhlNoteSyncSheet(salesCallLogRows);
  const salesCellWrites = [];
  salesSheet.getRange = (function (orig) {
    return function (row, col, numRows, numCols) {
      if (numRows !== undefined) return orig(row, col, numRows, numCols);
      if (row === 1 && col === undefined) return { getValues: () => [ghlNoteSyncHeaders()] };
      return { setValue: (v) => salesCellWrites.push({ row: row, col: col, value: v }) };
    };
  })(salesSheet.getRange);
  gas.SpreadsheetApp = {
    openById: () => ({
      getSheetByName: (name) => (name === 'GHL Note Sync Log' ? logSheet : salesSheet)
    })
  };
  Object.assign(gas, mocks);
  try {
    return fn(logSheet, salesCellWrites);
  } finally {
    Object.assign(gas, originals);
  }
}

test('revertGhlNoteSync_ deletes the GHL note when a note id is on file, unchecks GHL Review Synced, and marks the log entry Reverted', () => {
  const dataRows = [ghlNoteSyncLogRow({ Row: 2, 'Prospect Name': 'Nicole Freed', 'Contact ID': 'c-1', 'Note ID': 'n-1' })];
  const salesCallLogRows = [ghlNoteSyncRow({ 'Prospect Name': 'Nicole Freed', 'GHL Review Synced': true })];
  let deletedArgs = null;
  withMockedGhlRevert_(dataRows, salesCallLogRows, {
    ghlDeleteContactNote_: (contactId, noteId) => { deletedArgs = [contactId, noteId]; return { ok: true }; }
  }, (logSheet, salesCellWrites) => {
    gas.revertGhlNoteSync_();
    assert.deepEqual(deletedArgs, ['c-1', 'n-1']);
    const uncheck = salesCellWrites.find((w) => w.col === gas.SALES_CALL_LOG_HEADERS.indexOf('GHL Review Synced') + 1);
    assert.equal(uncheck.value, false);
    const revertedMark = logSheet._cellWrites.find((w) => w.col === gas.GHL_NOTE_SYNC_LOG_HEADERS.indexOf('Reverted') + 1);
    assert.equal(revertedMark.value, true);
  });
});

test('revertGhlNoteSync_ uncheck-only (no delete call) when an entry has no note id on file', () => {
  const dataRows = [ghlNoteSyncLogRow({ Row: 2, 'Prospect Name': 'No Note Id Guy', 'Contact ID': 'c-1', 'Note ID': '' })];
  const salesCallLogRows = [ghlNoteSyncRow({ 'Prospect Name': 'No Note Id Guy', 'GHL Review Synced': true })];
  let deleteCalls = 0;
  withMockedGhlRevert_(dataRows, salesCallLogRows, {
    ghlDeleteContactNote_: () => { deleteCalls++; return { ok: true }; }
  }, (logSheet, salesCellWrites) => {
    gas.revertGhlNoteSync_();
    assert.equal(deleteCalls, 0);
    const uncheck = salesCellWrites.find((w) => w.col === gas.SALES_CALL_LOG_HEADERS.indexOf('GHL Review Synced') + 1);
    assert.equal(uncheck.value, false);
  });
});

test('revertGhlNoteSync_ never re-processes an already-reverted entry', () => {
  const dataRows = [ghlNoteSyncLogRow({ Row: 2, 'Prospect Name': 'Already Done', 'Contact ID': 'c-1', 'Note ID': 'n-1', Reverted: true })];
  let deleteCalls = 0;
  withMockedGhlRevert_(dataRows, [], {
    ghlDeleteContactNote_: () => { deleteCalls++; return { ok: true }; }
  }, () => {
    gas.revertGhlNoteSync_();
    assert.equal(deleteCalls, 0);
  });
});

test('revertGhlNoteSync_ leaves an entry un-reverted (does not mark Reverted) when the GHL delete itself fails, so a re-run retries it', () => {
  const dataRows = [ghlNoteSyncLogRow({ Row: 2, 'Prospect Name': 'Delete Fails Guy', 'Contact ID': 'c-1', 'Note ID': 'n-1' })];
  const salesCallLogRows = [ghlNoteSyncRow({ 'Prospect Name': 'Delete Fails Guy', 'GHL Review Synced': true })];
  withMockedGhlRevert_(dataRows, salesCallLogRows, {
    ghlDeleteContactNote_: () => ({ ok: false, status: 500, body: 'server error' })
  }, (logSheet) => {
    gas.revertGhlNoteSync_();
    assert.equal(logSheet._cellWrites.length, 0, 'Reverted must NOT be set true when the delete failed');
  });
});

test('runGhlNoteSync_ caps the batch at GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN by stopping the SCAN itself early, not just slicing a finished plan (real bug found live 05/09/2026: a "3-row test batch" still ran the full ~470-call scan first, defeating the point of a small first live run)', () => {
  const dataRows = [
    ghlNoteSyncRow({ 'Prospect Name': 'Row A', 'Lead Quality Verdict': 'Qualified' }),
    ghlNoteSyncRow({ 'Prospect Name': 'Row B', 'Lead Quality Verdict': 'Qualified' })
  ];
  const sheet = fakeGhlNoteSyncSheet(dataRows);
  sheet.getRange = (function (orig) {
    return function (row, col, numRows, numCols) {
      if (numRows !== undefined) return orig(row, col, numRows, numCols);
      if (row === 1 && col === undefined) return { getValues: () => [ghlNoteSyncHeaders()] };
      return { setValue: () => {} };
    };
  })(sheet.getRange);

  const originalEnabled = gas.GHL_NOTE_SYNC_CONFIG.ENABLED;
  const originalMaxRows = gas.GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN;
  const originalGhlCheckSetup = gas.ghlCheckSetup_;
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalUtilities = gas.Utilities;
  const originalSearch = gas.ghlSearchContactByName_;
  const originalPost = gas.ghlPostContactNote_;
  let postCalls = 0;
  let searchCalls = 0;
  try {
    gas.GHL_NOTE_SYNC_CONFIG.ENABLED = true;
    gas.GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN = 1;
    gas.ghlCheckSetup_ = () => 'loc-1';
    gas.Utilities = { sleep: () => {}, formatDate: realFormatDate };
    gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => sheet }) };
    gas.ghlSearchContactByName_ = (locId, name) => { searchCalls++; return { ok: true, contacts: [{ id: 'c-1', name: name }] }; };
    gas.ghlPostContactNote_ = () => { postCalls++; return { ok: true, noteId: 'n-' + postCalls }; };

    const originalLog = gas.Logger.log;
    const lines = [];
    gas.Logger.log = (msg) => lines.push(msg);
    try {
      gas.runGhlNoteSync_();
    } finally {
      gas.Logger.log = originalLog;
    }

    assert.equal(searchCalls, 1, 'must stop searching GHL after the cap is reached, not scan every row first');
    assert.equal(postCalls, 1, 'must only post the capped number of notes, not all planned ones');
    assert.ok(lines.some((l) => l.indexOf('reached maxToPlan (1)') !== -1));
  } finally {
    gas.GHL_NOTE_SYNC_CONFIG.ENABLED = originalEnabled;
    gas.GHL_NOTE_SYNC_CONFIG.MAX_ROWS_PER_RUN = originalMaxRows;
    gas.ghlCheckSetup_ = originalGhlCheckSetup;
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.Utilities = originalUtilities;
    gas.ghlSearchContactByName_ = originalSearch;
    gas.ghlPostContactNote_ = originalPost;
  }
});

// ---------------------------------------------------------------------------
// Phase 13 — lead reconciliation (Phase13_LeadReconciliation.gs). Read-only
// audit answering "is every lead in every spreadsheet actually in GHL?"
// ---------------------------------------------------------------------------

test('collectLeadsFromRows_ skips rows with neither name nor email (trailing blanks / checkbox-extended empty rows) but keeps email-only and name-only rows', () => {
  const values = [
    ['Prospect Name', 'Prospect Email'],
    ['Ward Frederick', 'ward@example.com'],
    ['', 'noname@example.com'],
    ['No Email Person', ''],
    ['', ''],
    ['   ', '   ']
  ];
  const leads = gas.collectLeadsFromRows_(values, 0, 1, 'Sales Call Log');
  assert.equal(leads.length, 3);
  // Array.from: the vm realm's Array prototype differs from the host's, so a
  // bare deepEqual on a vm-produced array fails on prototype identity alone.
  assert.deepEqual(Array.from(leads.map((l) => l.name)), ['Ward Frederick', '', 'No Email Person']);
  assert.equal(leads[0].sourceRow, 2); // 1-based sheet row, header is row 1
  assert.equal(leads[1].email, 'noname@example.com');
});

test('collectLeadsFromRows_ lowercases and trims email so the same person written two ways dedupes to one lead', () => {
  const values = [['Name', 'Email'], ['Ward Frederick', '  WARD@Example.COM ']];
  const leads = gas.collectLeadsFromRows_(values, 0, 1, 'src');
  assert.equal(leads[0].email, 'ward@example.com');
});

test('collectLeadsFromRows_ tolerates a source with no email column at all (nameIdx/emailIdx of -1)', () => {
  const values = [['Name'], ['Ward Frederick']];
  const leads = gas.collectLeadsFromRows_(values, 0, -1, 'src');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].email, '');
});

test('dedupeReconciliationLeads_ collapses the same person appearing in several spreadsheets into one lead to check, keyed on email', () => {
  const distinct = gas.dedupeReconciliationLeads_([
    { name: 'Ward Frederick', email: 'ward@example.com', source: 'Sales Call Log', sourceRow: 111 },
    { name: 'Ward Frederick', email: 'ward@example.com', source: 'Reply Tracker', sourceRow: 4 },
    { name: 'Deme Mekras', email: '', source: 'Sales Call Log', sourceRow: 37 }
  ]);
  assert.equal(distinct.length, 2);
  assert.equal(distinct[0].occurrences, 2);
  assert.deepEqual(Array.from(distinct[0].sources), ['Sales Call Log:111', 'Reply Tracker:4']);
});

test('dedupeReconciliationLeads_ falls back to the normalized name when a source has no email, so name-only rows still get checked', () => {
  const distinct = gas.dedupeReconciliationLeads_([
    { name: 'Deme Mekras', email: '', source: 'a', sourceRow: 2 },
    { name: '  deme   mekras ', email: '', source: 'b', sourceRow: 9 }
  ]);
  assert.equal(distinct.length, 1);
  assert.equal(distinct[0].occurrences, 2);
});

test('dedupeReconciliationLeads_ does NOT merge a name-only record into an email-bearing one — over-reporting a lead costs a search, under-reporting loses it entirely', () => {
  const distinct = gas.dedupeReconciliationLeads_([
    { name: 'Ward Frederick', email: 'ward@example.com', source: 'a', sourceRow: 2 },
    { name: 'Ward Frederick', email: '', source: 'b', sourceRow: 3 }
  ]);
  assert.equal(distinct.length, 2);
});

test('dedupeReconciliationLeads_ drops a row that has neither a usable name nor an email rather than emitting a keyless lead', () => {
  const distinct = gas.dedupeReconciliationLeads_([{ name: '', email: '', source: 'a', sourceRow: 2 }]);
  assert.equal(distinct.length, 0);
});

test('dedupeReconciliationLeads_ backfills a missing name from another source that had one, so the report is human-readable', () => {
  const distinct = gas.dedupeReconciliationLeads_([
    { name: '', email: 'ward@example.com', source: 'Reply Tracker', sourceRow: 4 },
    { name: 'Ward Frederick', email: 'ward@example.com', source: 'Sales Call Log', sourceRow: 111 }
  ]);
  assert.equal(distinct.length, 1);
  assert.equal(distinct[0].name, 'Ward Frederick');
});

test('classifyLeadGhlPresence_ returns not_found when GHL returns only unrelated people (the real "Desiree Doggett" failure mode — without this the audit reports a clean bill of health while being entirely wrong)', () => {
  const verdict = gas.classifyLeadGhlPresence_(
    { name: 'Desiree Doggett', email: '' },
    [{ id: '1', name: 'Someone Else' }, { id: '2', name: 'Another Person' }]
  );
  assert.equal(verdict.status, 'not_found');
});

test('classifyLeadGhlPresence_ returns found for a single real name-token match', () => {
  const verdict = gas.classifyLeadGhlPresence_(
    { name: 'Ward Frederick', email: '' },
    [{ id: 'abc', name: 'Ward Frederick' }, { id: 'xyz', name: 'Totally Unrelated' }]
  );
  assert.equal(verdict.status, 'found');
  assert.equal(verdict.matches.length, 1);
  assert.equal(verdict.matches[0].id, 'abc');
});

test('classifyLeadGhlPresence_ matches on exact email even when the GHL contact name looks nothing like the sheet name (married/changed names, nicknames)', () => {
  const verdict = gas.classifyLeadGhlPresence_(
    { name: 'Pam Flitton', email: 'pamela@example.com' },
    [{ id: 'abc', name: 'Pamela Smith-Flitton', email: 'PAMELA@example.com' }]
  );
  assert.equal(verdict.status, 'found');
});

test('classifyLeadGhlPresence_ returns ambiguous rather than guessing when two plausible contacts match — guessing is how a lead gets someone else\'s call history', () => {
  const verdict = gas.classifyLeadGhlPresence_(
    { name: 'David Crum', email: '' },
    [{ id: '1', name: 'David Crum' }, { id: '2', name: 'David Crum' }]
  );
  assert.equal(verdict.status, 'ambiguous');
  assert.equal(verdict.matches.length, 2);
});

test('classifyLeadGhlPresence_ returns not_found for an empty GHL result set', () => {
  assert.equal(gas.classifyLeadGhlPresence_({ name: 'Nobody', email: '' }, []).status, 'not_found');
  assert.equal(gas.classifyLeadGhlPresence_({ name: 'Nobody', email: '' }, null).status, 'not_found');
});

test('buildLeadReconciliationSummary_ counts each bucket and flags a partial run so a capped scan is never mistaken for a complete audit', () => {
  const summary = gas.buildLeadReconciliationSummary_([
    { status: 'found' }, { status: 'found' }, { status: 'not_found' }, { status: 'ambiguous' }
  ], 4, 40, true);
  assert.ok(summary.indexOf('Checked 4 of 40') !== -1);
  assert.ok(summary.indexOf('in GHL:      2') !== -1);
  assert.ok(summary.indexOf('NOT in GHL:  1') !== -1);
  assert.ok(summary.indexOf('ambiguous:   1') !== -1);
  assert.ok(summary.indexOf('PARTIAL RUN') !== -1);
});

test('buildLeadReconciliationSummary_ omits the PARTIAL RUN warning on a complete run', () => {
  const summary = gas.buildLeadReconciliationSummary_([{ status: 'found' }], 1, 1, false);
  assert.ok(summary.indexOf('PARTIAL RUN') === -1);
});

// ---------------------------------------------------------------------------
// Phase 14 — GHL stage triage (Phase14_GhlStageTriage.gs). Suggests a
// resolution for stale, non-terminal GHL opportunities so Tomás/Joana can
// approve or reject instead of us guessing or writing to GHL automatically.
// ---------------------------------------------------------------------------

test('ghlOpportunityStaleDays_ computes whole days since updatedAt, and prefers updatedAt over lastStatusChangeAt/dateAdded', () => {
  const now = new Date('2026-09-05T00:00:00Z').getTime();
  const days = gas.ghlOpportunityStaleDays_({ updatedAt: '2026-08-15T00:00:00Z' }, now);
  assert.equal(days, 21);
});

test('ghlOpportunityStaleDays_ falls back to lastStatusChangeAt then dateAdded when updatedAt is missing', () => {
  const now = new Date('2026-09-05T00:00:00Z').getTime();
  assert.equal(gas.ghlOpportunityStaleDays_({ lastStatusChangeAt: '2026-09-01T00:00:00Z' }, now), 4);
  assert.equal(gas.ghlOpportunityStaleDays_({ dateAdded: '2026-09-04T00:00:00Z' }, now), 1);
});

test('ghlOpportunityStaleDays_ returns null (not a crash or a false "0 days") when no date field exists or is unparseable', () => {
  const now = Date.now();
  assert.equal(gas.ghlOpportunityStaleDays_({}, now), null);
  assert.equal(gas.ghlOpportunityStaleDays_({ updatedAt: 'not-a-date' }, now), null);
});

test('ghlStageIsTerminal_ matches "Closed Won"/"Closed lost" case-insensitively and rejects a normal in-flight stage', () => {
  assert.equal(gas.ghlStageIsTerminal_('Closed Won'), true);
  assert.equal(gas.ghlStageIsTerminal_('Closed lost'), true);
  assert.equal(gas.ghlStageIsTerminal_('Sales Call - Booked'), false);
});

test('buildGhlStageTriageSuggestion_ says leave-as-is when a real future appointment exists, even on a very stale stage', () => {
  const s = gas.buildGhlStageTriageSuggestion_({
    stageName: 'Sales Call - Booked', staleDays: 60, activity: { hasFutureAppointment: true }
  });
  assert.ok(/Leave as-is/.test(s.action));
});

test('buildGhlStageTriageSuggestion_ flags a stale "Booked" stage with zero activity as likely no-show/dead — the largest documented blind spot (GHL_PIPELINE_MAP.md)', () => {
  const s = gas.buildGhlStageTriageSuggestion_({
    stageName: 'Qualification Call Booked', staleDays: 45, activity: {}
  });
  assert.ok(/No-Show|Not Taken|re-engage/.test(s.action));
  assert.ok(/45 day/.test(s.reasoning));
});

test('buildGhlStageTriageSuggestion_ distinguishes "has real activity but stalled" from "no activity at all found" so the reasoning is never a guess', () => {
  const withActivity = gas.buildGhlStageTriageSuggestion_({
    stageName: 'Dial 1', staleDays: 30, activity: { lastNoteDate: '2026-08-20' }
  });
  const withoutActivity = gas.buildGhlStageTriageSuggestion_({
    stageName: 'Dial 1', staleDays: 30, activity: {}
  });
  assert.ok(/has activity, but stalled/.test(withActivity.action));
  assert.ok(withActivity.reasoning.indexOf('2026-08-20') !== -1);
  assert.ok(/no activity found at all/.test(withoutActivity.action));
});

test('buildGhlStageTriageSuggestion_ picks the MORE RECENT of note vs conversation date when both exist', () => {
  const s = gas.buildGhlStageTriageSuggestion_({
    stageName: 'Dial 1', staleDays: 30,
    activity: { lastNoteDate: '2026-07-01', lastConversationDate: '2026-08-15' }
  });
  assert.ok(s.reasoning.indexOf('2026-08-15') !== -1);
});

test('ghlStageTriageAlreadyDecided_ recognizes an opportunity id already on the sheet, so a re-run never re-suggests or duplicates a row a human already decided on', () => {
  assert.equal(gas.ghlStageTriageAlreadyDecided_(['opp1', 'opp2'], 'opp2'), true);
  assert.equal(gas.ghlStageTriageAlreadyDecided_(['opp1', 'opp2'], 'opp3'), false);
  assert.equal(gas.ghlStageTriageAlreadyDecided_([], 'opp1'), false);
});

test('nextGhlStageTriageWriteRow_ finds the real next row by content, not sheet.getLastRow() — the actual bug hit live (05/09/2026): checkbox-formatted blank rows made getLastRow() report 999 with zero real data, pushing the first batch of suggestions down to row 1000', () => {
  const values = {
    2: [''], 3: [''] // rows 2-3 exist per getLastRow() but have blank Opportunity IDs (checkbox padding)
  };
  const fakeSheet = {
    getLastRow: () => 3,
    getRange: (row, col, numRows, numCols) => {
      assert.equal(col, 4); // Opportunity ID column
      const out = [];
      for (let r = row; r < row + numRows; r++) out.push([values[r] !== undefined ? values[r][0] : '']);
      return { getValues: () => out };
    }
  };
  assert.equal(gas.nextGhlStageTriageWriteRow_(fakeSheet), 2);
});

test('nextGhlStageTriageWriteRow_ writes immediately after the last row that actually has an Opportunity ID, skipping past real data correctly', () => {
  const values = { 2: ['opp-a'], 3: ['opp-b'], 4: [''] };
  const fakeSheet = {
    getLastRow: () => 4,
    getRange: (row, col, numRows) => {
      const out = [];
      for (let r = row; r < row + numRows; r++) out.push([values[r] !== undefined ? values[r][0] : '']);
      return { getValues: () => out };
    }
  };
  assert.equal(gas.nextGhlStageTriageWriteRow_(fakeSheet), 4);
});

test('nextGhlStageTriageWriteRow_ returns row 2 for a brand-new sheet with no data rows at all', () => {
  assert.equal(gas.nextGhlStageTriageWriteRow_({ getLastRow: () => 1 }), 2);
});

test('readExistingGhlStageTriageOpportunityIds_ filters out blank/checkbox-padding rows so they never get reported as real decisions', () => {
  const values = { 2: [''], 3: ['opp-real'], 4: ['  '] };
  const fakeSheet = {
    getLastRow: () => 4,
    getRange: (row, col, numRows) => {
      const out = [];
      for (let r = row; r < row + numRows; r++) out.push([values[r] !== undefined ? values[r][0] : '']);
      return { getValues: () => out };
    }
  };
  const ids = gas.readExistingGhlStageTriageOpportunityIds_(fakeSheet);
  assert.deepEqual(Array.from(ids), ['opp-real']);
});

test('classifyReconciliationNoise_ flags the outreach tool\'s own sender address as noise, not a lead — the real pattern found live (05/09/2026): 300+ "not in GHL" hits were all network@ardorseo.com', () => {
  const v = gas.classifyReconciliationNoise_({ name: "'Joana Peixe' via Network", email: 'network@ardorseo.com' });
  assert.equal(v.isNoise, true);
  assert.ok(/cold-outreach/.test(v.reason));
});

test('classifyReconciliationNoise_ flags an internal @iconsofrealestate.com address as noise (team member, not a lead)', () => {
  assert.equal(gas.classifyReconciliationNoise_({ name: 'Sean Church', email: 'sean@iconsofrealestate.com' }).isNoise, true);
});

test('classifyReconciliationNoise_ flags known email-newsletter names and Zoom recording filenames that leaked into the Prospect Name column', () => {
  assert.equal(gas.classifyReconciliationNoise_({ name: 'The Daily Skimm', email: '' }).isNoise, true);
  assert.equal(gas.classifyReconciliationNoise_({ name: 'Entrepreneur Daily', email: '' }).isNoise, true);
  assert.equal(gas.classifyReconciliationNoise_({ name: 'GMT20260822-005817_Recording_640x360', email: '' }).isNoise, true);
  assert.equal(gas.classifyReconciliationNoise_({ name: "Joana's Transcriptions", email: '' }).isNoise, true);
});

test('classifyReconciliationNoise_ does NOT flag a real prospect name/email — this is advisory tagging, never a filter that could hide a real lead', () => {
  const v = gas.classifyReconciliationNoise_({ name: 'Andrew Leitheiser', email: '' });
  assert.equal(v.isNoise, false);
  assert.equal(v.reason, '');
});

test('buildLeadReconciliationReviewRow_ has the same dedupe key dedupeReconciliationLeads_ uses at a fixed position (index 10, column K) — not "last element," since Needs More Info (06/09/2026) is appended after it', () => {
  const row = gas.buildLeadReconciliationReviewRow_({
    lead: { name: 'Ward Frederick', email: 'ward@example.com', sources: ['Sales Call Log:111'] },
    status: 'not_found', matches: []
  });
  assert.equal(row[10], 'email:ward@example.com');
  assert.equal(row[1], 'Ward Frederick');
  assert.equal(row[3], 'not_found');
  assert.equal(row[11], false); // Needs More Info, default unset
});

test('buildLeadReconciliationReviewRow_ falls back to a normalized-name key when there is no email, matching dedupeReconciliationLeads_\'s own fallback', () => {
  const row = gas.buildLeadReconciliationReviewRow_({
    lead: { name: 'Deme Mekras', email: '', sources: ['Sales Call Log:37'] }, status: 'not_found', matches: []
  });
  assert.equal(row[10], 'name:deme mekras');
});

test('buildLeadReconciliationReviewRow_ tags the noise columns inline, so "All" and "Candidates" can be built from the exact same row shape', () => {
  const row = gas.buildLeadReconciliationReviewRow_({
    lead: { name: 'Sean Church', email: 'sean@iconsofrealestate.com', sources: ['Reply Tracker:12'] },
    status: 'not_found', matches: []
  });
  assert.equal(row[5], true); // Likely Noise
  assert.ok(row[6]); // Noise Reason non-empty
});

test('nextReconciliationReviewWriteRow_ and readExistingReconciliationReviewKeys_ use the Dedupe Key column (K), not sheet.getLastRow() alone — same fix as Phase14\'s checkbox bug, applied here before it could happen', () => {
  const values = { 2: [''], 3: ['email:ward@example.com'], 4: [''] };
  const fakeSheet = {
    getLastRow: () => 4,
    getRange: (row, col, numRows) => {
      assert.equal(col, 11);
      const out = [];
      for (let r = row; r < row + numRows; r++) out.push([values[r] !== undefined ? values[r][0] : '']);
      return { getValues: () => out };
    }
  };
  assert.deepEqual(Array.from(gas.readExistingReconciliationReviewKeys_(fakeSheet)), ['email:ward@example.com']);
  assert.equal(gas.nextReconciliationReviewWriteRow_(fakeSheet), 4);
});

test('writeLeadReconciliationReviewRows_ skips a result whose dedupe key is already on the sheet, so a re-run never duplicates a still-missing lead\'s row', () => {
  const written = [];
  let insertCheckboxesCallCount = 0;
  const fakeSheet = {
    getLastRow: () => 2, // header only, existing key check reads nothing
    getLastColumn: () => 12, // full header width already — no migration needed
    getRange: () => ({
      getValues: () => [],
      setValues: (rows) => { written.push(...rows); },
      insertCheckboxes: () => { insertCheckboxesCallCount++; }
    })
  };
  const originalSS = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet, insertSheet: () => fakeSheet }) };
  try {
    const results = [
      { lead: { name: 'Ward Frederick', email: 'ward@example.com', sources: ['a'] }, status: 'not_found', matches: [] }
    ];
    const count = gas.writeLeadReconciliationReviewRows_('Lead Reconciliation - All', results, gas.buildLeadReconciliationReviewRow_);
    assert.equal(count, 1);
    assert.equal(written.length, 1);
    // Two separate checkbox ranges: Real Lead/Not a real lead (I:J), and
    // Needs More Info (L, non-adjacent — Dedupe Key K sits between them).
    assert.equal(insertCheckboxesCallCount, 2);
  } finally {
    gas.SpreadsheetApp = originalSS;
  }
});

// ---------------------------------------------------------------------------
// "Needs More Info" (Kris, 06/09/2026): "Add another button. Don't
// know...so that if he doesn't understand he can just hit that. Then
// afterwards, you can do an analysis and give him more information." Both
// review sheets' header-migration path (an already-existing sheet gets the
// new header cell appended, without touching any already-written header).
// ---------------------------------------------------------------------------

test('getOrCreateLeadReconciliationReviewSheet_ extends an existing sheet\'s header row with "Needs More Info" without touching already-written headers', () => {
  let headerWrite = null;
  const fakeSheet = {
    getLastColumn: () => 11, // pre-existing sheet, before "Needs More Info" was added
    getRange: (row, col, numRows, numCols) => {
      assert.equal(row, 1);
      assert.equal(col, 12); // right after the existing 11 columns
      return {
        setValues: (vals) => { headerWrite = vals; return { setFontWeight: () => {} }; }
      };
    }
  };
  const originalSS = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet }) };
  try {
    gas.getOrCreateLeadReconciliationReviewSheet_('Lead Reconciliation - All');
  } finally {
    gas.SpreadsheetApp = originalSS;
  }
  assert.ok(headerWrite, 'the missing header cell should have been written');
  assert.deepEqual(Array.from(headerWrite[0]), ['Needs More Info']);
});

test('getOrCreateCrmOrganizationReviewSheet_ extends an existing sheet\'s header row with "Needs More Info" without touching already-written headers', () => {
  let headerWrite = null;
  const fakeSheet = {
    getLastColumn: () => 8, // pre-existing sheet, before "Needs More Info" was added
    getRange: (row, col, numRows, numCols) => {
      assert.equal(row, 1);
      assert.equal(col, 9); // right after the existing 8 columns
      return {
        setValues: (vals) => { headerWrite = vals; return { setFontWeight: () => {} }; }
      };
    }
  };
  const originalSS = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet }) };
  try {
    gas.getOrCreateCrmOrganizationReviewSheet_();
  } finally {
    gas.SpreadsheetApp = originalSS;
  }
  assert.ok(headerWrite, 'the missing header cell should have been written');
  assert.deepEqual(Array.from(headerWrite[0]), ['Needs More Info']);
});

test('getOrCreateCrmOrganizationReviewSheet_ does nothing to an already-fully-migrated sheet\'s header row', () => {
  let getRangeCalled = false;
  const fakeSheet = {
    getLastColumn: () => 9, // already has "Needs More Info"
    getRange: () => { getRangeCalled = true; return { setValues: () => ({ setFontWeight: () => {} }) }; }
  };
  const originalSS = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet }) };
  try {
    gas.getOrCreateCrmOrganizationReviewSheet_();
  } finally {
    gas.SpreadsheetApp = originalSS;
  }
  assert.equal(getRangeCalled, false);
});

// ---------------------------------------------------------------------------
// Weekly training rotation (Kris, 05/09/2026): "unless there is something
// urgent to focus on I want to cycle through Week 1: Discovery / Week 2:
// Framework & Delivery / Week 3: closing & Objection Handling" — replacing
// "always pick whichever single element failed the most" with a team-wide
// curriculum, still overridable per rep by a genuinely urgent issue.
// ---------------------------------------------------------------------------

test('trainingRotationIndexForWeekNumber_ cycles 0,1,2,0,1,2... starting from week 1 -> index 0 (Discovery)', () => {
  assert.equal(gas.trainingRotationIndexForWeekNumber_(1), 0);
  assert.equal(gas.trainingRotationIndexForWeekNumber_(2), 1);
  assert.equal(gas.trainingRotationIndexForWeekNumber_(3), 2);
  assert.equal(gas.trainingRotationIndexForWeekNumber_(4), 0);
  assert.equal(gas.trainingRotationIndexForWeekNumber_(52), 0);
  assert.equal(gas.trainingRotationIndexForWeekNumber_(53), 1);
});

test('pickWeeklyTrainingFocus_ uses the scheduled topic when nothing outside it is urgent, combining its elements\' failed/scored counts', () => {
  const call = (score, flags) => ({ score, flags });
  const calls = [
    call(2, { discovery: true, framework: false, delivery: false, ask: true, objections: true }),
    call(3, { discovery: true, framework: true, delivery: false, ask: true, objections: true })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const schedule = { label: 'Framework & Delivery', keys: ['framework', 'delivery'] };
  const focus = gas.pickWeeklyTrainingFocus_(ranking, schedule);
  assert.equal(focus.isUrgentOverride, false);
  assert.equal(focus.label, 'Framework & Delivery');
  assert.equal(focus.failed, 3); // framework failed 1 + delivery failed 2
  assert.equal(focus.scored, 4); // framework scored 2 + delivery scored 2
});

test('pickWeeklyTrainingFocus_ de-duplicates a call that fails BOTH elements of a two-element week, never double-listing it', () => {
  const call = (score, flags) => ({ score, flags });
  const bothFail = call(1, { discovery: true, framework: false, delivery: false, ask: true, objections: true });
  const calls = [bothFail];
  const ranking = gas.rankTrainingPriorities_(calls);
  const schedule = { label: 'Framework & Delivery', keys: ['framework', 'delivery'] };
  const focus = gas.pickWeeklyTrainingFocus_(ranking, schedule);
  assert.equal(focus.failedCalls.length, 1, 'the same call must not appear twice just because it failed two elements');
});

test('pickWeeklyTrainingFocus_ overrides the schedule when an OUTSIDE element is urgent (2+ failed calls averaging <=2)', () => {
  const call = (score, flags) => ({ score, flags });
  // Scheduled week is Discovery, but objections fails 3 calls at a low average.
  const calls = [
    call(2, { discovery: true, framework: true, delivery: true, ask: true, objections: false }),
    call(1, { discovery: true, framework: true, delivery: true, ask: true, objections: false }),
    call(2, { discovery: true, framework: true, delivery: true, ask: true, objections: false })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const schedule = { label: 'Discovery', keys: ['discovery'] };
  const focus = gas.pickWeeklyTrainingFocus_(ranking, schedule);
  assert.equal(focus.isUrgentOverride, true);
  assert.equal(focus.label, 'Objection handling');
  assert.equal(focus.scheduleLabel, 'Discovery');
});

test('pickWeeklyTrainingFocus_ does NOT override for a single bad call outside the schedule — one call is normal variance, not urgent', () => {
  const call = (score, flags) => ({ score, flags });
  const calls = [
    call(1, { discovery: true, framework: true, delivery: true, ask: true, objections: false }), // only 1 failed call
    call(5, { discovery: true, framework: true, delivery: true, ask: true, objections: true })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const schedule = { label: 'Discovery', keys: ['discovery'] };
  const focus = gas.pickWeeklyTrainingFocus_(ranking, schedule);
  assert.equal(focus.isUrgentOverride, false);
  assert.equal(focus.label, 'Discovery');
});

test('pickWeeklyTrainingFocus_ does NOT override for a recurring failure that still scores decently (2+ failed but average > 2) — urgency needs both a pattern AND a genuinely poor score', () => {
  const call = (score, flags) => ({ score, flags });
  const calls = [
    call(3, { discovery: true, framework: true, delivery: true, ask: true, objections: false }),
    call(3, { discovery: true, framework: true, delivery: true, ask: true, objections: false })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const schedule = { label: 'Discovery', keys: ['discovery'] };
  const focus = gas.pickWeeklyTrainingFocus_(ranking, schedule);
  assert.equal(focus.isUrgentOverride, false);
});

test('pickWeeklyTrainingFocus_ never overrides FOR an element that is already inside this week\'s schedule (no such thing as an "urgent override" onto the same topic)', () => {
  const call = (score, flags) => ({ score, flags });
  // discovery (inside schedule) is badly failing; nothing outside the schedule is.
  const calls = [
    call(1, { discovery: false, framework: true, delivery: true, ask: true, objections: true }),
    call(1, { discovery: false, framework: true, delivery: true, ask: true, objections: true })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const schedule = { label: 'Discovery', keys: ['discovery'] };
  const focus = gas.pickWeeklyTrainingFocus_(ranking, schedule);
  assert.equal(focus.isUrgentOverride, false);
  assert.equal(focus.label, 'Discovery');
});

test('buildPlaybookReviewNewMaterialEmail_ names the scheduled topic in the body when an urgent override fires, so Tomás sees why the session deviated from the announced curriculum', () => {
  const repCfg = { name: 'Sean' };
  const focus = { label: 'Objection handling', failed: 3, scored: 5, failedCalls: [], isUrgentOverride: true, scheduleLabel: 'Discovery' };
  const flagged = [{ prospectName: 'x', callDate: '01/09/2026', feedback: 'x' }];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026', [], focus);
  assert.ok(email.subject.indexOf('objection handling') !== -1);
  assert.ok(email.body.indexOf('urgent override') !== -1);
  assert.ok(email.body.indexOf('Discovery') !== -1);
  assert.ok(email.htmlBody.indexOf('urgent override') !== -1);
});

test('buildPlaybookReviewNewMaterialEmail_ says nothing about an override when focus came from the normal schedule', () => {
  const repCfg = { name: 'Sean' };
  const focus = { label: 'Framework & Delivery', failed: 2, scored: 4, failedCalls: [], isUrgentOverride: false, scheduleLabel: 'Framework & Delivery' };
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, [], '24/08/2026 - 30/08/2026', [], focus);
  assert.equal(email.body.indexOf('urgent override'), -1);
});

test('rankTrainingPriorities_ ranks the new "delivery" element same as any other — appended without disturbing the four original elements\' relative order (existing behavior unchanged)', () => {
  const call = (score, flags) => ({ score, flags });
  const calls = [
    call(2, { discovery: false, framework: true, delivery: true, ask: false, objections: true }),
    call(3, { discovery: false, framework: true, delivery: true, ask: true, objections: true }),
    call(2, { discovery: false, framework: true, delivery: true, ask: false, objections: false }),
    call(5, { discovery: true, framework: true, delivery: true, ask: true, objections: true })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  assert.equal(ranking.length, 5);
  assert.equal(ranking[0].key, 'discovery');
  assert.equal(ranking[4].key, 'delivery', 'delivery has zero failures here and, appended last, sorts last among the ties');
});

// ---------------------------------------------------------------------------
// Real bug found live (05/09/2026): Bens's daily practice drill got graded
// and coached as if he were "asking for the money," which is never his job
// — he books a QC/Sales Call for someone else on the team. Kris: "Bens is
// lead generation... He never asks for the money. Joana, Sean, Tomas ask
// for the money! NOT Bens."
// ---------------------------------------------------------------------------

test('buildDailyPracticeSystemPrompt_ uses Bens\'s real skill ("asking for the appointment") instead of hardcoding "ASKING FOR THE MONEY" for every rep', () => {
  const bensPrompt = gas.buildDailyPracticeSystemPrompt_('Bens');
  assert.ok(bensPrompt.indexOf('ASKING FOR THE APPOINTMENT') !== -1,
    'Bens\'s prompt must name his real skill, not money');
  assert.equal(bensPrompt.indexOf('ASKING FOR THE MONEY'), -1,
    'Bens must never be told to grade against a money-closing skill he doesn\'t have');
  assert.ok(bensPrompt.indexOf('book the next concrete step') !== -1,
    'Bens\'s skill description (booking a QC/Sales Call) must come from trainingReviewRoleFor_, not be invented here');
});

test('buildDailyPracticeSystemPrompt_ still says "ASKING FOR THE MONEY" for a rep with no custom role (Sean/Joana) — the fix must not remove the real skill for the reps it DOES apply to', () => {
  const seanPrompt = gas.buildDailyPracticeSystemPrompt_('Sean');
  assert.ok(seanPrompt.indexOf('ASKING FOR THE MONEY') !== -1);
});

test('buildDailyPracticeFeedbackEmail_ labels a close_ask drill "Asking for the appointment" for Bens, not "Asking for the money"', () => {
  const result = {
    drill_type: 'close_ask', objection_type: 'n/a', technique_used: true, technique_description: 'x',
    delivery_quality: 'confident', overall_score: 4, sharpen_next: 'x', feedback_summary: '"x" — good.'
  };
  const email = gas.buildDailyPracticeFeedbackEmail_('Bens', '260902_objection_practice.mp4', result);
  assert.ok(email.body.indexOf('Drill: Asking for the appointment') !== -1);
  assert.equal(email.body.indexOf('Asking for the money'), -1);
});

test('buildDailyPracticeFeedbackEmail_ still labels a close_ask drill "Asking for the money" for a rep with no custom role', () => {
  const result = {
    drill_type: 'close_ask', objection_type: 'n/a', technique_used: true, technique_description: 'x',
    delivery_quality: 'confident', overall_score: 4, sharpen_next: 'x', feedback_summary: '"x" — good.'
  };
  const email = gas.buildDailyPracticeFeedbackEmail_('Sean', '260902_objection_practice.mp4', result);
  assert.ok(email.body.indexOf('Drill: Asking for the money') !== -1);
});

// ---------------------------------------------------------------------------
// The weekly training rotation (Discovery / Framework & Delivery / Closing &
// Objection Handling) is a team-wide curriculum for the reps who actually
// close (Joana, Sean) — Kris, 05/09/2026, correcting an assumption baked
// into the rotation the same day it shipped: "Remember this only applies to
// Joana, Sean NOT Bens." Bens never asks for money and never explains the
// framework (trainingReviewRoleFor_), so two of the three scheduled weeks
// aren't his job at all.
// ---------------------------------------------------------------------------

test('legacyTrainingFocusFromRanking_ picks the single worst-ranked element, same as the pre-rotation rule, with no schedule attached', () => {
  const ranking = [
    { label: 'Discovery', failed: 3, scored: 4, failedCalls: ['a', 'b', 'c'] },
    { label: 'Objection handling', failed: 1, scored: 4, failedCalls: ['d'] }
  ];
  const focus = gas.legacyTrainingFocusFromRanking_(ranking);
  assert.equal(focus.label, 'Discovery');
  assert.equal(focus.failed, 3);
  assert.equal(focus.isUrgentOverride, false);
  assert.equal(focus.scheduleLabel, null);
});

test('legacyTrainingFocusFromRanking_ handles an empty ranking (no calls last week) without throwing', () => {
  const focus = gas.legacyTrainingFocusFromRanking_([]);
  assert.equal(focus.failed, 0);
  assert.deepEqual(Array.from(focus.failedCalls), []);
});

// ---------------------------------------------------------------------------
// Training Priority Override — Kris's ask (07/09/2026): "every Tuesday
// morning... tell him what the priority is for each sales rep... if he does
// nothing, it goes with that. Otherwise, he can log into the interface and
// change it." Tomás's dashboard write (tools/dashboard/sheets_write.py)
// appends a row; these are the read-side pure functions that make that
// override actually take effect.
// ---------------------------------------------------------------------------

test('findTrainingPriorityOverride_ finds a row matching (rep, week start), case-insensitive on rep', () => {
  const rows = [
    ['Sean', '07/09/2026', 'Discovery', 'tomas@iconsofrealestate.com', '2026-09-07T09:00:00Z'],
    ['Joana', '07/09/2026', 'Closing & Objection Handling', 'tomas@iconsofrealestate.com', '2026-09-07T09:05:00Z']
  ];
  assert.equal(gas.findTrainingPriorityOverride_(rows, 'sean', '07/09/2026'), 'Discovery');
  assert.equal(gas.findTrainingPriorityOverride_(rows, 'Joana', '07/09/2026'), 'Closing & Objection Handling');
});

test('findTrainingPriorityOverride_ returns null when nothing matches this rep/week — the auto-computed pick must win', () => {
  const rows = [['Sean', '07/09/2026', 'Discovery', 'tomas@iconsofrealestate.com', '2026-09-07T09:00:00Z']];
  assert.equal(gas.findTrainingPriorityOverride_(rows, 'Joana', '07/09/2026'), null, 'different rep');
  assert.equal(gas.findTrainingPriorityOverride_(rows, 'Sean', '14/09/2026'), null, 'different week');
  assert.equal(gas.findTrainingPriorityOverride_([], 'Sean', '07/09/2026'), null, 'no rows at all');
});

test('findTrainingPriorityOverride_ uses the LAST matching row — append-only writes mean the newest override wins', () => {
  const rows = [
    ['Sean', '07/09/2026', 'Discovery', 'tomas@iconsofrealestate.com', '2026-09-07T09:00:00Z'],
    ['Sean', '07/09/2026', 'Closing & Objection Handling', 'tomas@iconsofrealestate.com', '2026-09-07T10:00:00Z']
  ];
  assert.equal(gas.findTrainingPriorityOverride_(rows, 'Sean', '07/09/2026'), 'Closing & Objection Handling');
});

test('namedTrainingFocusFromRanking_ resolves a WEEKLY_TRAINING_ROTATION_ schedule label to the union of its elements\' real data', () => {
  const call = (score, flags) => ({ score, flags });
  const calls = [
    call(2, { discovery: true, framework: false, delivery: false, ask: true, objections: true }),
    call(3, { discovery: true, framework: true, delivery: false, ask: true, objections: true })
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const focus = gas.namedTrainingFocusFromRanking_(ranking, 'Framework & Delivery');
  assert.equal(focus.label, 'Framework & Delivery');
  assert.equal(focus.failed, 3); // framework failed 1 + delivery failed 2, same union as pickWeeklyTrainingFocus_'s own test
  assert.equal(focus.scored, 4);
  assert.equal(focus.isManualOverride, true);
});

test('namedTrainingFocusFromRanking_ resolves a single TRAINING_PRIORITY_ELEMENTS_ label (e.g. "Discovery") to just that element', () => {
  const call = (score, flags) => ({ score, flags });
  const calls = [call(1, { discovery: false, framework: true, delivery: true, ask: true, objections: true })];
  const ranking = gas.rankTrainingPriorities_(calls);
  const focus = gas.namedTrainingFocusFromRanking_(ranking, 'discovery'); // case-insensitive
  assert.equal(focus.label, 'Discovery');
  assert.equal(focus.failed, 1);
  assert.equal(focus.scored, 1);
  assert.equal(focus.isManualOverride, true);
});

test('namedTrainingFocusFromRanking_ degrades gracefully to a bare label with no supporting data when the text matches nothing recognized', () => {
  const focus = gas.namedTrainingFocusFromRanking_([], 'Some Typo Tomas Made');
  assert.equal(focus.label, 'Some Typo Tomas Made');
  assert.equal(focus.failed, 0);
  assert.equal(focus.scored, 0);
  assert.deepEqual(Array.from(focus.failedCalls), []);
  assert.equal(focus.isManualOverride, true);
});

// ---------------------------------------------------------------------------
// An override that names an element with NOTHING to show (real bug, live
// 08/09/2026): Tomás set "Discovery" for Joana in a week where not one of
// her 4 calls was graded on discovery, so the override produced failed:0/
// scored:0, buildAndMaybeSendPlaybookReview_ read that as "nothing flagged",
// and Tomás got the empty "no flagged calls last week" email — for a rep who
// had failed framework explanation on 4 of 4 graded calls that week.
// ---------------------------------------------------------------------------

/** Joana's real week, 31/08-06/09/2026: framework failed 4 of 4, objections 2 of 4, ask 1 of 4, discovery never graded. */
function joanaUngradedDiscoveryRanking_(gas) {
  const call = (score, flags) => ({ score, flags });
  return gas.rankTrainingPriorities_([
    call(2, { discovery: null, framework: false, delivery: true, ask: false, objections: false }),
    call(3, { discovery: null, framework: false, delivery: true, ask: true, objections: false }),
    call(4, { discovery: null, framework: false, delivery: true, ask: true, objections: true }),
    call(4, { discovery: null, framework: false, delivery: true, ask: true, objections: true })
  ]);
}

test('resolveTrainingFocusWithOverride_ returns the auto-computed focus untouched when Tomás set no override', () => {
  const ranking = joanaUngradedDiscoveryRanking_(gas);
  const auto = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Closing & Objection Handling', keys: ['ask', 'objections'] });
  const resolved = gas.resolveTrainingFocusWithOverride_(ranking, null, auto);
  assert.equal(resolved, auto, 'no override means the auto-computed focus object passes straight through');
});

test('resolveTrainingFocusWithOverride_ honours an override that HAS failing calls, even when it is not the worst element (Sean/Discovery, the case that worked)', () => {
  const call = (score, flags) => ({ score, flags });
  // Discovery failed 1 of 4; asking for the money failed 3 of 5 — the override
  // must still win, that is the entire point of letting Tomás steer.
  const ranking = gas.rankTrainingPriorities_([
    call(1, { discovery: false, framework: false, delivery: true, ask: false, objections: false }),
    call(2, { discovery: true, framework: false, delivery: true, ask: false, objections: false }),
    call(4, { discovery: true, framework: true, delivery: true, ask: false, objections: true }),
    call(4, { discovery: true, framework: true, delivery: true, ask: true, objections: true }),
    call(4, { discovery: null, framework: true, delivery: true, ask: true, objections: true })
  ]);
  const auto = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Closing & Objection Handling', keys: ['ask', 'objections'] });
  const resolved = gas.resolveTrainingFocusWithOverride_(ranking, 'Discovery', auto);
  assert.equal(resolved.label, 'Discovery');
  assert.equal(resolved.failed, 1);
  assert.equal(resolved.isManualOverride, true);
  assert.ok(!resolved.overrideFellBack, 'an override with real material must never fall back');
});

test('resolveTrainingFocusWithOverride_ KEEPS the override when the element nobody was graded on is picked — Tomás steers, the bot does not overrule him', () => {
  const ranking = joanaUngradedDiscoveryRanking_(gas);
  const auto = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Closing & Objection Handling', keys: ['ask', 'objections'] });
  const resolved = gas.resolveTrainingFocusWithOverride_(ranking, 'Discovery', auto);

  // Kris, 08/09/2026: "Tomas is meant to be training discovery." An earlier
  // version substituted the auto-computed focus here and silently retargeted
  // the session, which is what he rejected.
  assert.equal(resolved.label, 'Discovery', 'the human\'s pick wins, full stop');
  assert.equal(resolved.isManualOverride, true);
  assert.equal(resolved.overrideFellBack, false, 'nothing falls back any more');
  assert.equal(resolved.overrideFallbackReason, 'not_graded',
    'but the email still has to be able to say WHY nothing was flagged');
  assert.equal(resolved.failed, 0, 'and it is honest that no failure was graded');
});

test('resolveTrainingFocusWithOverride_ distinguishes "graded and all passed" from "never graded"', () => {
  const call = (score, flags) => ({ score, flags });
  // Delivery WAS graded on all 3 calls and passed every one; framework failed 3 of 3.
  const ranking = gas.rankTrainingPriorities_([
    call(2, { discovery: null, framework: false, delivery: true, ask: false, objections: true }),
    call(2, { discovery: null, framework: false, delivery: true, ask: false, objections: true }),
    call(3, { discovery: null, framework: false, delivery: true, ask: true, objections: true })
  ]);
  const auto = gas.legacyTrainingFocusFromRanking_(ranking);
  const resolved = gas.resolveTrainingFocusWithOverride_(ranking, 'Delivery', auto);
  assert.equal(resolved.label, 'Delivery', 'still his pick, not the worst element');
  assert.equal(resolved.overrideFallbackReason, 'all_passed');
  assert.equal(resolved.overrideRequestedScored, 3, 'reports how many were graded, so "all passed" is checkable');
});

test('resolveTrainingFocusWithOverride_ keeps Tomás\'s own label on a genuinely clean week too, and records why it was empty', () => {
  const call = (score, flags) => ({ score, flags });
  // A genuinely clean week: everything graded passed, discovery never graded.
  const ranking = gas.rankTrainingPriorities_([
    call(5, { discovery: null, framework: true, delivery: true, ask: true, objections: true })
  ]);
  const auto = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Closing & Objection Handling', keys: ['ask', 'objections'] });
  const resolved = gas.resolveTrainingFocusWithOverride_(ranking, 'Discovery', auto);
  assert.equal(resolved.label, 'Discovery', 'nothing better to show, so his pick stays on the email');
  assert.equal(resolved.overrideFellBack, false);
  assert.equal(resolved.overrideRequestedLabel, 'Discovery');
  assert.equal(resolved.overrideFallbackReason, 'not_graded', 'the no-flagged-calls email needs this to explain itself');
});

test('playbookFocusNote_ explains an override that nothing was flagged for, without claiming the focus changed', () => {
  const note = gas.playbookFocusNote_({
    label: 'Discovery', isManualOverride: true, isUrgentOverride: false,
    overrideFellBack: false, overrideRequestedLabel: 'Discovery', overrideFallbackReason: 'not_graded'
  });
  assert.ok(note.indexOf('you set this via the dashboard') !== -1);
  assert.ok(note.indexOf('no call was graded on it') !== -1);
  assert.equal(note.indexOf('instead'), -1, 'the focus did NOT change, so the note must not imply it did');

  const allPassed = gas.playbookFocusNote_({
    isManualOverride: true, overrideRequestedLabel: 'Delivery', overrideFallbackReason: 'all_passed',
    overrideRequestedScored: 3
  });
  assert.ok(allPassed.indexOf('all 3 graded call(s) passed it') !== -1);
});

test('playbookFocusNote_ leaves the existing manual-override/urgent-override/plain wording exactly as it was', () => {
  assert.equal(gas.playbookFocusNote_({ isManualOverride: true }), ' — you set this manually via the dashboard');
  assert.equal(gas.playbookFocusNote_({ isUrgentOverride: true, scheduleLabel: 'Discovery' }),
    ' — urgent override; this week\'s scheduled topic is "Discovery"');
  assert.equal(gas.playbookFocusNote_({}), '');
  assert.equal(gas.playbookFocusNote_(null), '');
});

test('playbookOverrideSentence_ is empty unless an override actually came up empty, so the no-flagged-calls email is unchanged for everyone else', () => {
  assert.equal(gas.playbookOverrideSentence_(null), '');
  assert.equal(gas.playbookOverrideSentence_({ label: 'Discovery' }), '', 'no override requested');
  const sentence = gas.playbookOverrideSentence_({
    overrideRequestedLabel: 'Discovery', overrideFallbackReason: 'not_graded'
  });
  assert.ok(sentence.indexOf('You picked "Discovery"') !== -1);
  assert.ok(sentence.indexOf('no call was graded on it') !== -1);
});

test('buildPlaybookReviewNewMaterialEmail_ keeps the override as the focus and lists the week\'s calls as review material, not as failures', () => {
  const ranking = joanaUngradedDiscoveryRanking_(gas);
  const auto = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Closing & Objection Handling', keys: ['ask', 'objections'] });
  const focus = gas.resolveTrainingFocusWithOverride_(ranking, 'Discovery', auto);
  const flagged = [{ prospectName: 'April Stephens', callDate: '01/09/2026', score: 2, feedback: 'ok' }];
  const email = gas.buildPlaybookReviewNewMaterialEmail_({ name: 'Joana' }, flagged, '31/08/2026 - 06/09/2026', ranking, focus);

  assert.ok(email.subject.indexOf('discovery') !== -1, 'the subject must name what Tomás actually picked');
  assert.ok(email.body.indexOf('you set this via the dashboard') !== -1);
  assert.equal(email.body.indexOf('that failed on discovery'), -1,
    'these calls were never graded on discovery — calling them failures would be a lie about the rep');
  assert.ok(email.body.indexOf('not one call last week carries a grade for it') !== -1,
    'it must say plainly why nothing was flagged');
  assert.ok(email.body.indexOf('whole week') !== -1, 'and hand Tomás the calls anyway');
  // And the real material is still there — that is the actual fix.
  assert.ok(email.body.indexOf('April Stephens') !== -1);

  // The date range belongs BEFORE the note, or the note's own sentence gets
  // a stray date range stapled to its end ("...so this is the auto-computed
  // focus instead last week (31/08/2026 - 06/09/2026)."). The htmlBody
  // always had this order; the plain-text body did not until 08/09/2026.
  const windowAt = email.body.indexOf('week of 31/08/2026 - 06/09/2026');
  assert.ok(windowAt !== -1, 'the week window must still be stated');
  assert.ok(windowAt < email.body.indexOf('you set this via the dashboard'),
    'window label must come before the focus note, same as the htmlBody');
  assert.equal(email.body.indexOf('failed on 0 of 0'), -1,
    'a focus nothing was graded on must not render a 0-of-0 failure count');
});

test('buildPlaybookReviewNoNewCallsEmail_ says the override came up empty when there was nothing to fall back to, and stays byte-identical when no override was set', () => {
  const withOverride = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Joana' }, '31/08/2026 - 06/09/2026', null, 4, {
    overrideRequestedLabel: 'Discovery', overrideFallbackReason: 'not_graded'
  });
  assert.ok(withOverride.body.indexOf('You picked "Discovery"') !== -1);
  assert.ok(withOverride.htmlBody.indexOf('You picked &quot;Discovery&quot;') !== -1 ||
    withOverride.htmlBody.indexOf('You picked "Discovery"') !== -1);

  const withoutOverride = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Joana' }, '31/08/2026 - 06/09/2026', null, 4);
  const noFocusArg = gas.buildPlaybookReviewNoNewCallsEmail_({ name: 'Joana' }, '31/08/2026 - 06/09/2026', null, 4, null);
  assert.equal(withoutOverride.body, noFocusArg.body, 'omitting the focus arg entirely must behave like passing null');
  assert.equal(withoutOverride.body.indexOf('You picked'), -1);
});

test('a rep who HAD calls but nothing flagged gets the calls listed, not a contentless email (Bens, 08/09/2026)', () => {
  // Bens's real shape: one call, nothing graded on it at all. The old email
  // said "none of the graded elements failed on any of them", which reads as
  // a clean week when in fact nothing was ever graded.
  const calls = [{
    prospectName: 'Jocelyne Yanez', callDate: '02/09/2026', score: 3, feedback: 'Booked the QC.',
    transcriptUrl: 'https://example.com/t/1',
    flags: { discovery: null, framework: null, delivery: null, ask: null, objections: null },
    gaps: {}
  }];
  const ranking = gas.rankTrainingPriorities_(calls);
  const focus = gas.legacyTrainingFocusFromRanking_(ranking);
  assert.equal(focus.failed, 0, 'precondition: nothing was flagged');

  const email = gas.buildPlaybookReviewNewMaterialEmail_({ name: 'Bens' }, calls, '31/08/2026 - 06/09/2026', ranking, focus);
  assert.ok(email.body.indexOf('Jocelyne Yanez') !== -1, 'the lead must be named — that is the whole ask');
  assert.ok(email.body.indexOf('https://example.com/t/1') !== -1, 'with the transcript to actually review');
  assert.ok(email.body.indexOf('not one call last week carries a grade for it') !== -1,
    'and it must say the truth: nothing was graded, which is NOT the same as everything passing');
  assert.equal(email.body.indexOf('that failed on'), -1,
    'a rep with no graded failures must never be described as having failed calls');
});

test('every focus-producing function carries the element keys it covers, so the per-call Missing line can find its Gaps column', () => {
  const ranking = gas.rankTrainingPriorities_([
    { score: 2, flags: { discovery: false, framework: false, delivery: false, ask: false, objections: false },
      gaps: { discovery: 'no pain uncovered', framework: 'skipped the guarantee', delivery: 'monotone' } }
  ]);

  const scheduled = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Framework & Delivery', keys: ['framework', 'delivery'] });
  assert.deepEqual(Array.from(scheduled.keys).sort(), ['delivery', 'framework'],
    'a two-element rotation week must carry BOTH keys, not one');

  // Urgent override: a single element outranking the schedule.
  const urgentRanking = gas.rankTrainingPriorities_([
    { score: 1, flags: { discovery: false, framework: true, delivery: true, ask: true, objections: true }, gaps: {} },
    { score: 1, flags: { discovery: false, framework: true, delivery: true, ask: true, objections: true }, gaps: {} }
  ]);
  const urgent = gas.pickWeeklyTrainingFocus_(urgentRanking, { label: 'Closing & Objection Handling', keys: ['ask', 'objections'] });
  assert.equal(urgent.isUrgentOverride, true, 'precondition: this is the urgent path');
  assert.deepEqual(Array.from(urgent.keys), ['discovery']);

  assert.deepEqual(Array.from(gas.legacyTrainingFocusFromRanking_(ranking).keys), [ranking[0].key]);
  assert.deepEqual(Array.from(gas.legacyTrainingFocusFromRanking_([]).keys), [], 'no ranking at all must not throw');

  assert.deepEqual(Array.from(gas.namedTrainingFocusFromRanking_(ranking, 'Discovery').keys), ['discovery']);
  assert.deepEqual(Array.from(gas.namedTrainingFocusFromRanking_(ranking, 'Framework & Delivery').keys).sort(),
    ['delivery', 'framework']);
  assert.deepEqual(Array.from(gas.namedTrainingFocusFromRanking_(ranking, 'Nonsense Tomás typed').keys), [],
    'unrecognized text still degrades gracefully rather than throwing');

  // And the override resolver must not drop keys on the way through.
  const overridden = gas.resolveTrainingFocusWithOverride_(ranking, 'Framework & Delivery', scheduled);
  assert.deepEqual(Array.from(overridden.keys).sort(), ['delivery', 'framework'],
    'an override carries its own keys, or Missing goes blank again');
  const passthrough = gas.resolveTrainingFocusWithOverride_(ranking, null, scheduled);
  assert.deepEqual(Array.from(passthrough.keys).sort(), ['delivery', 'framework'],
    'and so does the no-override passthrough');
});

test('playbookFocusGapsForCall_ shows the Gaps text only for focus elements the call actually failed', () => {
  const call = {
    flags: { discovery: false, framework: true, delivery: false, ask: false, objections: false },
    gaps: { discovery: 'no pain uncovered', framework: 'skipped the guarantee', delivery: 'monotone' }
  };

  const single = gas.playbookFocusGapsForCall_({ keys: ['discovery'] }, call);
  assert.equal(single.length, 1);
  assert.equal(single[0].text, 'no pain uncovered');
  assert.equal(single[0].label, 'Discovery');

  // framework PASSED on this call — printing its gap text would invent a
  // failure the grader never recorded.
  const pair = gas.playbookFocusGapsForCall_({ keys: ['framework', 'delivery'] }, call);
  assert.deepEqual(Array.from(pair).map((g) => g.label), ['Delivery'],
    'the element the call passed must be left out');

  // 'ask'/'objections' have no Gaps column at all by design.
  assert.equal(gas.playbookFocusGapsForCall_({ keys: ['ask', 'objections'] }, call).length, 0);

  // Defensive shapes must not throw.
  assert.equal(gas.playbookFocusGapsForCall_(null, call).length, 0);
  assert.equal(gas.playbookFocusGapsForCall_({ keys: ['discovery'] }, {}).length, 0);
  assert.equal(gas.playbookFocusGapsForCall_({}, call).length, 0, 'a focus with no keys yields nothing, not a crash');

  // A call with no flags at all (older rows, hand-built fixtures) still shows
  // its gap text rather than silently dropping it.
  const noFlags = gas.playbookFocusGapsForCall_({ keys: ['discovery'] }, { gaps: { discovery: 'no pain uncovered' } });
  assert.equal(noFlags.length, 1);
});

test('playbookFocusGapsText_ names the element only when the focus spans more than one', () => {
  const call = {
    flags: { discovery: false, framework: false, delivery: false },
    gaps: { discovery: 'no pain uncovered', framework: 'skipped the guarantee', delivery: 'monotone' }
  };
  assert.equal(gas.playbookFocusGapsText_({ keys: ['discovery'] }, call), 'no pain uncovered',
    'single-element focus: the label is already the email headline');
  assert.equal(gas.playbookFocusGapsText_({ keys: ['framework', 'delivery'] }, call),
    'Framework explanation — skipped the guarantee; Delivery — monotone');
  assert.equal(gas.playbookFocusGapsText_({ keys: ['ask'] }, call), '');
});

test('playbookElementSeverityColor_ colors by failure RATE, not raw count, and never colors an ungraded element as if it passed', () => {
  assert.equal(gas.playbookElementSeverityColor_({ failed: 0, scored: 0 }), '#888', 'ungraded must be grey, not green');
  assert.equal(gas.playbookElementSeverityColor_({ failed: 0, scored: 5 }), '#1a7a3c', 'a real clean pass is green');
  assert.equal(gas.playbookElementSeverityColor_({ failed: 1, scored: 5 }), '#b8860b', 'a minority failure is amber');
  assert.equal(gas.playbookElementSeverityColor_({ failed: 3, scored: 5 }), '#c0392b', 'a majority failure is red');
  assert.equal(gas.playbookElementSeverityColor_({ failed: 1, scored: 2 }), '#c0392b', '50% exactly counts as red, same threshold as >= 0.5');
});

test('playbookFeedbackLineHtml_ turns an all-flags line into colored pass/fail pills, and leaves prose alone', () => {
  const pillLine = gas.playbookFeedbackLineHtml_('Discovery adequate: false | Understood lead&#39;s business: true');
  assert.ok(pillLine.indexOf('&#10007; Discovery adequate: FALSE') !== -1, 'a false flag gets the X mark');
  assert.ok(pillLine.indexOf('&#10003; Understood lead&#39;s business: TRUE') !== -1, 'a true flag gets the check mark');
  assert.ok(pillLine.indexOf('#c0392b') !== -1 && pillLine.indexOf('#1a7a3c') !== -1,
    'false and true segments on the SAME line must get different colors independently');

  const withSuffix = gas.playbookFeedbackLineHtml_('Framework explained: false (missing: recruit agents)');
  assert.ok(withSuffix.indexOf('(missing: recruit agents)') !== -1, 'the parenthetical detail must survive, not get eaten by the pill regex');

  const rootCause = gas.playbookFeedbackLineHtml_('Root cause if no sale: the call never got past setup.');
  assert.ok(rootCause.indexOf('background:#f4f7fb') !== -1, 'a Root cause line gets its own muted callout box');
  assert.equal(rootCause.indexOf('&#10003;'), -1, 'a Root cause line must never be mistaken for a flag pill');

  const prose = gas.playbookFeedbackLineHtml_('That patience was the right instinct given the circumstances.');
  assert.equal(prose.indexOf('&#10003;'), -1);
  assert.equal(prose.indexOf('background:#f4f7fb'), -1);
  assert.ok(prose.indexOf('<p style="margin:0 0 6px;line-height:1.45;">') !== -1, 'ordinary narrative gets normal paragraph spacing, not crammed via <br>');
});

test('playbookFeedbackHtml_ splits multi-line feedback into separate readable blocks and keeps quote italicization', () => {
  const html = gas.playbookFeedbackHtml_('"He asked for the money."\nDiscovery adequate: true\nRoot cause if no sale: N/A.');
  assert.ok(html.indexOf('<i>&quot;He asked for the money.&quot;</i>') !== -1, 'quotes stay italicized');
  assert.ok(html.indexOf('&#10003; Discovery adequate: TRUE') !== -1);
  assert.ok(html.indexOf('background:#f4f7fb') !== -1);
  // Three distinct blank lines in, three distinct <p> blocks out — not one
  // undifferentiated wall of text (the exact complaint, 08/09/2026: "These
  // walls of text are hard to read").
  assert.equal((html.match(/<p /g) || []).length, 3);

  assert.equal(gas.playbookFeedbackHtml_(''), '<p style="margin:0 0 6px;line-height:1.45;">(no AI feedback summary on file)</p>',
    'missing feedback still renders something rather than an empty block');
});

test('buildPlaybookReviewNewMaterialEmail_ actually renders the Missing line end to end (it never did before 08/09/2026)', () => {
  const calls = [
    { prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 2, feedback: 'ok',
      flags: { discovery: false, framework: true, delivery: true, ask: true, objections: true },
      gaps: { discovery: 'never confirmed what the QC already surfaced', framework: '', delivery: '' } },
    { prospectName: 'Roxy Miles', callDate: '28/08/2026', score: 3, feedback: 'ok',
      flags: { discovery: false, framework: true, delivery: true, ask: true, objections: true },
      gaps: { discovery: 'no budget question at all', framework: '', delivery: '' } }
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const focus = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Discovery', keys: ['discovery'] });
  const email = gas.buildPlaybookReviewNewMaterialEmail_(
    { name: 'Joana' }, focus.failedCalls, '24/08/2026 - 30/08/2026', ranking, focus);

  assert.ok(email.body.indexOf('Missing: never confirmed what the QC already surfaced') !== -1,
    'plain body must carry the per-call gap detail');
  assert.ok(email.body.indexOf('Missing: no budget question at all') !== -1,
    'and for every flagged call, not just the first');
  assert.ok(email.htmlBody.indexOf('Missing:</strong> never confirmed what the QC already surfaced') !== -1,
    'the HTML version must carry it too');
});

test('buildPlaybookReviewNewMaterialEmail_ omits the Missing line for a focus whose elements have no Gaps column', () => {
  const calls = [
    { prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 2, feedback: 'ok',
      flags: { discovery: true, framework: true, delivery: true, ask: false, objections: false },
      gaps: { discovery: 'not relevant to this focus', framework: '', delivery: '' } }
  ];
  const ranking = gas.rankTrainingPriorities_(calls);
  const focus = gas.pickWeeklyTrainingFocus_(ranking, { label: 'Closing & Objection Handling', keys: ['ask', 'objections'] });
  const email = gas.buildPlaybookReviewNewMaterialEmail_(
    { name: 'Sean' }, focus.failedCalls, '24/08/2026 - 30/08/2026', ranking, focus);

  assert.equal(email.body.indexOf('Missing:'), -1,
    'ask/objections have gapsColumn:null — no Missing line, and definitely not discovery\'s');
  assert.equal(email.body.indexOf('not relevant to this focus'), -1,
    'a gap from an element outside the focus must never leak in');
});

test('getOrCreateTrainingPriorityOverridesSheet_ creates the tab with frozen bold headers exactly once, reusing it on a second call', () => {
  const created = [];
  let existingSheet = null;
  const fakeSheet = {
    getRange: () => ({ setValues: () => ({ setFontWeight: () => ({ setBackground: () => {} }) }) }),
    setFrozenRows: () => {}
  };
  const fakeSs = {
    getSheetByName: (name) => { assert.equal(name, 'Training Priority Overrides'); return existingSheet; },
    insertSheet: (name) => { created.push(name); existingSheet = fakeSheet; return fakeSheet; }
  };
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => fakeSs };
  try {
    const first = gas.getOrCreateTrainingPriorityOverridesSheet_();
    const second = gas.getOrCreateTrainingPriorityOverridesSheet_();
    assert.equal(first, fakeSheet);
    assert.equal(second, fakeSheet);
    assert.deepEqual(created, ['Training Priority Overrides'], 'must only insert the sheet once');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

test('TRAINING_REVIEW_ROLE_ has no entry for Sean/Joana, only Bens — this is the exact flag buildAndMaybeSendPlaybookReview_ uses to decide who gets the team rotation vs. the legacy per-rep worst-element rule', () => {
  assert.ok(gas.TRAINING_REVIEW_ROLE_.Bens, 'Bens must have a custom role entry');
  assert.equal(gas.TRAINING_REVIEW_ROLE_.Sean, undefined, 'Sean must use the team rotation (no custom role entry)');
  assert.equal(gas.TRAINING_REVIEW_ROLE_.Joana, undefined, 'Joana must use the team rotation (no custom role entry)');
});

// ---------------------------------------------------------------------------
// refreshBacklogRecordingMissingFlags_ — Option A from Kris's 04/09/2026
// email to Tomás re: Sean's stale "4 no outcome logged / 2 no recording"
// split ("all 6 actually have no recording, but the label was stale").
// ---------------------------------------------------------------------------

test('refreshBacklogRecordingMissingFlags_ flips a stale "no recording" entry to "no outcome logged" once ANY row (even unlogged) shows up for it — the exact bug Kris described', () => {
  var backlog = [
    { eventId: 'evt-1', prospectGuess: 'Russell Kubach', callDateLabel: '25/08/2026', attendeeEmails: [], recordingMissing: true }
  ];
  // A row now exists (the recording arrived and got scored) but the rep
  // still hasn't filled in Outcome Disposition, so it's unlogged.
  var allRowsAnyDate = [
    { rowIndex: 7, prospect: 'russellkubach', email: '', eventId: 'evt-1', logged: false }
  ];
  var result = gas.refreshBacklogRecordingMissingFlags_('Sean', backlog, allRowsAnyDate);
  assert.equal(result[0].recordingMissing, false);
});

test('refreshBacklogRecordingMissingFlags_ flips the other direction too: "no outcome logged" becomes "no recording" if the row that used to justify it is gone', () => {
  var backlog = [
    { eventId: 'evt-1', prospectGuess: 'Russell Kubach', callDateLabel: '25/08/2026', attendeeEmails: [], recordingMissing: false }
  ];
  var result = gas.refreshBacklogRecordingMissingFlags_('Sean', backlog, []); // no rows at all anywhere
  assert.equal(result[0].recordingMissing, true);
});

test('refreshBacklogRecordingMissingFlags_ leaves an entry alone (no log line, no change) when the label is already correct', () => {
  var backlog = [
    { eventId: 'evt-1', prospectGuess: 'Russell Kubach', callDateLabel: '25/08/2026', attendeeEmails: [], recordingMissing: true }
  ];
  var result = gas.refreshBacklogRecordingMissingFlags_('Sean', backlog, []); // still nothing — stays "no recording"
  assert.equal(result[0].recordingMissing, true);
});

test('refreshBacklogRecordingMissingFlags_ does not let one loosely-matched row clear two different entries\' recordingMissing at once', () => {
  var backlog = [
    { eventId: null, title: 'QC / Russell Kubach', prospectGuess: 'Russell Kubach', callDateLabel: '25/08/2026', attendeeEmails: [], recordingMissing: true },
    { eventId: null, title: 'Sales Call / Russell Kubach', prospectGuess: 'Russell Kubach', callDateLabel: '26/08/2026', attendeeEmails: [], recordingMissing: true }
  ];
  // Only ONE row exists for "Russell Kubach", no event ID to disambiguate.
  var allRowsAnyDate = [
    { rowIndex: 7, prospect: 'russell kubach', email: '', eventId: '', logged: false }
  ];
  var result = gas.refreshBacklogRecordingMissingFlags_('Sean', backlog, allRowsAnyDate);
  var stillMissing = result.filter(function (e) { return e.recordingMissing; });
  assert.equal(stillMissing.length, 1, 'only one of the two entries may claim the single matching row');
});

// ---------------------------------------------------------------------------
// Average score + total trainings on the daily practice feedback email
// (Kris, 05/09/2026: "Score: 4/5 - can we also include the average score" /
// "Average score and total trainings done").
// ---------------------------------------------------------------------------

test('computeDailyPracticeScoreStats_ averages and counts, rounded to one decimal', () => {
  const stats = gas.computeDailyPracticeScoreStats_([4, 3, 5]);
  assert.equal(stats.count, 3);
  assert.equal(stats.average, 4); // (4+3+5)/3 = 4 exactly
});

test('computeDailyPracticeScoreStats_ rounds to one decimal place, not a long float', () => {
  const stats = gas.computeDailyPracticeScoreStats_([4, 3, 4]);
  assert.equal(stats.average, 3.7); // 11/3 = 3.666... -> 3.7
});

test('computeDailyPracticeScoreStats_ returns count:0, average:null for no scores at all — never NaN or a divide-by-zero', () => {
  const stats = gas.computeDailyPracticeScoreStats_([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.average, null);
});

test('computeDailyPracticeScoreStats_ ignores non-numeric entries mixed into the array', () => {
  const stats = gas.computeDailyPracticeScoreStats_([4, null, undefined, 2]);
  assert.equal(stats.count, 2);
  assert.equal(stats.average, 3);
});

test('priorDailyPracticeScoresForRep_ only returns scores for the requested rep, skipping blanks and other reps', () => {
  const rows = [
    ['Sean', 260819, '', 'graded', '', 0, '', 4],
    ['Sean', 260820, '', 'graded', '', 0, '', ''], // ungraded/blank score — must be excluded
    ['Bens', 260819, '', 'graded', '', 0, '', 5]
  ];
  const sheet = {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows })
  };
  const scores = gas.priorDailyPracticeScoresForRep_(sheet, 'Sean');
  assert.deepEqual(Array.from(scores), [4]);
});

test('buildDailyPracticeFeedbackEmail_ shows the average score and total trainings when stats are provided', () => {
  const result = {
    drill_type: 'objection', objection_type: 'timing', technique_used: true, technique_description: 'x',
    delivery_quality: 'confident', overall_score: 4, sharpen_next: 'x', feedback_summary: '"x" — good.'
  };
  const email = gas.buildDailyPracticeFeedbackEmail_('Sean', 'x.mp4', result, {}, { count: 5, average: 3.6 });
  assert.ok(email.body.indexOf('Average score to date: 3.6/5 (5 training(s) total)') !== -1);
  assert.ok(email.htmlBody.indexOf('<strong>Average score to date:</strong> 3.6/5 (5 training(s) total)') !== -1);
});

test('buildDailyPracticeFeedbackEmail_ omits the average line entirely on a rep\'s very first graded drill (count:0) rather than showing "null/5"', () => {
  const result = {
    drill_type: 'objection', objection_type: 'timing', technique_used: true, technique_description: 'x',
    delivery_quality: 'confident', overall_score: 4, sharpen_next: 'x', feedback_summary: '"x" — good.'
  };
  const email = gas.buildDailyPracticeFeedbackEmail_('Sean', 'x.mp4', result); // no stats param at all — old call shape
  assert.equal(email.body.indexOf('Average score'), -1);
  assert.equal(email.htmlBody.indexOf('Average score'), -1);
});

// ---------------------------------------------------------------------------
// Real bug found live (05/09/2026): Reply Tracker's 'From' column was
// configured as the lead-name source, but Phase8_ReplyTracker.gs:237
// documents it as always the raw From header of the outreach relay/forward
// address (e.g. "'Joana Peixe' via Network" <network@ardorseo.com>) — the
// SAME text on nearly every row, never the real lead's name. This made
// ~470 distinct real leads all search GHL under that one garbage string
// instead of their own email, and showed it as every one of their "Name"
// cells on the review sheets.
// ---------------------------------------------------------------------------

test('LEAD_RECONCILIATION_SOURCES has no nameColumns for Reply Tracker — "From" is always the relay/forward address (Phase8_ReplyTracker.gs), never the prospect\'s real name', () => {
  const replyTracker = gas.LEAD_RECONCILIATION_SOURCES.filter((s) => s.label === 'Reply Tracker')[0];
  assert.ok(replyTracker, 'Reply Tracker source must still exist');
  assert.deepEqual(Array.from(replyTracker.nameColumns), []);
  assert.deepEqual(Array.from(replyTracker.emailColumns), ['Lead Email']);
});

test('collectLeadsFromRows_ with no name column (nameIdx -1) leaves the lead\'s name blank rather than picking up an unrelated column — this is what fixes the Reply Tracker bug at the source', () => {
  const values = [
    ['From', 'Lead Email'],
    ["'Joana Peixe' via Network <network@ardorseo.com>", 'realagent@example.com']
  ];
  const leads = gas.collectLeadsFromRows_(values, -1, 1, 'Reply Tracker');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].name, '');
  assert.equal(leads[0].email, 'realagent@example.com');
});

// ---------------------------------------------------------------------------
// One-time repair (05/09/2026): the fix above stopped NEW rows getting the
// relay's From header as their Name, but review-sheet rows from BEFORE the
// fix already had it, keyed on the (already-correct) email — so a plain
// re-run skips them as "already listed" instead of fixing the bad Name.
// leadReconciliationNameLooksLikeReplyRelay_ is the pure detector behind
// repairLeadReconciliationReplyTrackerNames_, confirmed live: it found 477
// leads to review but only wrote 34 new rows, since ~440 already existed
// under the same email key with the stale garbage Name.
// ---------------------------------------------------------------------------

test('leadReconciliationNameLooksLikeReplyRelay_ flags a Name cell holding the outreach relay\'s raw From header', () => {
  assert.equal(gas.leadReconciliationNameLooksLikeReplyRelay_("'Joana Peixe' via Network <network@ardorseo.com>"), true);
  assert.equal(gas.leadReconciliationNameLooksLikeReplyRelay_('Network <network@ardorseo.com>'), true);
});

test('leadReconciliationNameLooksLikeReplyRelay_ leaves a real lead\'s name alone', () => {
  assert.equal(gas.leadReconciliationNameLooksLikeReplyRelay_('Craig Sanger'), false);
  assert.equal(gas.leadReconciliationNameLooksLikeReplyRelay_(''), false);
  assert.equal(gas.leadReconciliationNameLooksLikeReplyRelay_(null), false);
});

test('repairLeadReconciliationReplyTrackerNames_ blanks only the relay-header Name cells, leaving real names untouched, and skips a sheet that does not exist yet', () => {
  let written = null;
  const fakeAllSheet = {
    getLastRow: () => 4,
    getRange: (row, col, numRows, numCols) => {
      assert.equal(row, 2);
      assert.equal(col, 2); // Name column
      assert.equal(numRows, 3);
      assert.equal(numCols, 1);
      return {
        getValues: () => [
          ["'Joana Peixe' via Network <network@ardorseo.com>"],
          ['Craig Sanger'],
          ['Network <network@ardorseo.com>']
        ],
        setValues: (vals) => { written = vals; }
      };
    }
  };
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = {
    openById: () => ({
      getSheetByName: (name) => (name === 'Lead Reconciliation - All' ? fakeAllSheet : null)
    })
  };
  try {
    gas.repairLeadReconciliationReplyTrackerNames_();
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
  assert.ok(written, 'the Name column should have been written back');
  assert.equal(written[0][0], '');
  assert.equal(written[1][0], 'Craig Sanger');
  assert.equal(written[2][0], '');
});

// ---------------------------------------------------------------------------
// Phase 15 — CRM organization review (Phase15_CrmOrganizationReview.gs).
// Read-only-against-GHL tool building an approve/reject sheet for Tomás's
// Monday CRM organization session with Joana.
// ---------------------------------------------------------------------------

test('classifyPipelineStageConcentration_ flags a pipeline where one stage holds the large majority of open opportunities', () => {
  const config = { STUCK_STAGE_SHARE_THRESHOLD: 0.7, MIN_OPPORTUNITIES_TO_FLAG: 20 };
  const stageCounts = { 'Attempted Contact': 29, 'Booked': 1 };
  const result = gas.classifyPipelineStageConcentration_('Cold Calling 2', stageCounts, config);
  assert.ok(result);
  assert.equal(result.pipelineName, 'Cold Calling 2');
  assert.equal(result.topStage, 'Attempted Contact');
  assert.equal(result.topCount, 29);
  assert.equal(result.total, 30);
  assert.equal(result.sharePct, 97);
});

test('classifyPipelineStageConcentration_ returns null when no single stage dominates', () => {
  const config = { STUCK_STAGE_SHARE_THRESHOLD: 0.7, MIN_OPPORTUNITIES_TO_FLAG: 20 };
  const stageCounts = { 'Attempted Contact': 10, 'Booked': 10, 'Follow-up': 10 };
  assert.equal(gas.classifyPipelineStageConcentration_('Healthy Pipeline', stageCounts, config), null);
});

test('classifyPipelineStageConcentration_ returns null when total opportunities is below the flag threshold, even at 100% concentration — a lopsided percentage off 3 leads isn\'t a real signal', () => {
  const config = { STUCK_STAGE_SHARE_THRESHOLD: 0.7, MIN_OPPORTUNITIES_TO_FLAG: 20 };
  const stageCounts = { 'Booked': 3 };
  assert.equal(gas.classifyPipelineStageConcentration_('Tiny Pipeline', stageCounts, config), null);
});

test('ghlAssigneeNameMatchesKnownRep_ matches a full GHL display name against a first-name-only known rep — real bug found live 06/09/2026: "Sean Church" was flagged unrecognized because CONFIG.REPS only stores "Sean"', () => {
  const knownNames = { sean: true };
  assert.equal(gas.ghlAssigneeNameMatchesKnownRep_('Sean Church', knownNames), true);
  assert.equal(gas.ghlAssigneeNameMatchesKnownRep_('Sean', knownNames), true);
});

test('ghlAssigneeNameMatchesKnownRep_ returns false for a genuinely different name', () => {
  assert.equal(gas.ghlAssigneeNameMatchesKnownRep_('Amanda Arambulo', { sean: true, joana: true }), false);
});

test('ghlAssigneeNameMatchesKnownRep_ returns false for blank input', () => {
  assert.equal(gas.ghlAssigneeNameMatchesKnownRep_('', { sean: true }), false);
  assert.equal(gas.ghlAssigneeNameMatchesKnownRep_(null, { sean: true }), false);
});

// ---------------------------------------------------------------------------
// Real bug found live (06/09/2026): assigneeCounts is keyed by the raw GHL
// USER ID (opp.assignedTo — never a name; that's why this file's whole
// ID->name resolution exists), but classifyUnknownAssignees_ used to compare
// that raw ID directly against knownNames (real rep NAMES) — which can never
// match, so every single assignee on every pipeline was flagged as
// "unrecognized," including actual team members like Sean and Joana.
// Fixed by requiring a userNameLookup (id -> name) and checking the RESOLVED
// name against knownNames instead.
// ---------------------------------------------------------------------------

test('classifyUnknownAssignees_ excludes a real rep once their ID resolves to their (fuller) GHL display name', () => {
  const knownNames = gas.knownGhlAssigneeNames_();
  const repName = gas.CONFIG.REPS[0].name; // e.g. 'Bens', 'Joana', or 'Sean' — first name only
  const assigneeCounts = { repUserId123: 5, oldRepUserId: 2, unknownUserId: 14 };
  const userNameLookup = {
    repUserId123: repName + ' Somebody', // simulates GHL's fuller display name
    oldRepUserId: 'Bruno',
    unknownUserId: 'Amanda Arambulo'
  };
  const unknown = gas.classifyUnknownAssignees_(assigneeCounts, knownNames, userNameLookup);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].name, 'unknownUserId');
  assert.equal(unknown[0].count, 14);
});

test('classifyUnknownAssignees_ treats an ID the lookup cannot resolve at all as unrecognized, not silently excluded', () => {
  const unknown = gas.classifyUnknownAssignees_({ someUserId: 3 }, gas.knownGhlAssigneeNames_(), {});
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].name, 'someUserId');
});

test('knownGhlAssigneeNames_ includes the team\'s confirmed full GHL display names (Kris, 06/09/2026) — including Tomás, who is never in CONFIG.REPS since he\'s the trainer/closer, not a scored rep', () => {
  const known = gas.knownGhlAssigneeNames_();
  ['Bens Olano', 'Sean Church', 'Joana Peixe', 'Tomas Fonseca', 'Tomás Fonseca'].forEach((fullName) => {
    assert.equal(known[gas.normalize_(fullName)], true, fullName + ' should be a known assignee');
  });
});

test('classifyUnknownAssignees_ excludes Tomás by his confirmed full name even though he is never in CONFIG.REPS', () => {
  const knownNames = gas.knownGhlAssigneeNames_();
  const unknown = gas.classifyUnknownAssignees_(
    { tomasUserId: 12 }, knownNames, { tomasUserId: 'Tomás Fonseca' }
  );
  assert.equal(unknown.length, 0);
});

test('classifyUnknownAssignees_ sorts unrecognized assignees by open-opportunity count, most first', () => {
  const lookup = { SC: 'Some Company', JP: 'John Public', BO: 'Bea Otherperson' };
  const unknown = gas.classifyUnknownAssignees_({ 'SC': 3, 'JP': 14, 'BO': 8 }, {}, lookup);
  assert.equal(Array.from(unknown).map((a) => a.name).join(','), 'JP,BO,SC');
});

test('classifyUnknownAssignees_ skips blank/whitespace-only assignee values', () => {
  const unknown = gas.classifyUnknownAssignees_({ '': 4, '   ': 2, 'KD': 1 }, {}, {});
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].name, 'KD');
  assert.equal(unknown[0].count, 1);
});

test('nextCrmOrganizationReviewWriteRow_ finds the real next row by content in the Finding column, not sheet.getLastRow() alone — same checkbox/getLastRow() bug class fixed in Phase14_GhlStageTriage.gs', () => {
  const values = { 2: [''], 3: [''] };
  const fakeSheet = {
    getLastRow: () => 3,
    getRange: (row, col, numRows, numCols) => {
      assert.equal(col, 3); // Finding column
      const out = [];
      for (let r = row; r < row + numRows; r++) out.push([values[r] !== undefined ? values[r][0] : '']);
      return { getValues: () => out };
    }
  };
  assert.equal(gas.nextCrmOrganizationReviewWriteRow_(fakeSheet), 2);
});

test('nextCrmOrganizationReviewWriteRow_ writes immediately after the last row that actually has a Finding', () => {
  const values = { 2: ['finding-a'], 3: ['finding-b'], 4: [''] };
  const fakeSheet = {
    getLastRow: () => 4,
    getRange: (row, col, numRows) => {
      const out = [];
      for (let r = row; r < row + numRows; r++) out.push([values[r] !== undefined ? values[r][0] : '']);
      return { getValues: () => out };
    }
  };
  assert.equal(gas.nextCrmOrganizationReviewWriteRow_(fakeSheet), 4);
});

test('nextCrmOrganizationReviewWriteRow_ returns row 2 for a brand-new sheet with no data rows at all', () => {
  assert.equal(gas.nextCrmOrganizationReviewWriteRow_({ getLastRow: () => 1 }), 2);
});

// ---------------------------------------------------------------------------
// Real bug found live (06/09/2026): a re-run of previewCrmOrganizationReview_
// wrote 10 new rows including exact duplicates of "Cold Calling 2"/"SALES
// CALL pipeline" already sitting in the sheet from the FIRST run — this file
// never had any dedupe check at all (unlike Phase13's dedupe-by-key).
// buildPipelineHealthDedupeKey_/buildUnrecognizedAssigneeDedupeKey_ give each
// finding a stable identity (the pipeline, or the assignee ID — not the
// current percentage/count, which naturally drifts run to run) and
// readExistingCrmOrganizationReviewKeys_ reads them back so a re-run can
// skip what's already listed.
// ---------------------------------------------------------------------------

test('buildPipelineHealthDedupeKey_ is stable across case/whitespace differences in the pipeline name', () => {
  assert.equal(gas.buildPipelineHealthDedupeKey_('Cold Calling 2'), gas.buildPipelineHealthDedupeKey_('  cold calling 2  '));
});

test('buildUnrecognizedAssigneeDedupeKey_ is keyed on the assignee ID, not any resolved name', () => {
  assert.equal(gas.buildUnrecognizedAssigneeDedupeKey_('j3B1N9nwTDvgLyLgbcjI'), 'assignee:j3B1N9nwTDvgLyLgbcjI');
});

test('readExistingCrmOrganizationReviewKeys_ reads the Dedupe Key column (H), skipping blanks', () => {
  const values = { 2: ['pipeline:cold calling 2'], 3: [''], 4: ['assignee:j3b1n9nwtdvglylgbcji'] };
  const fakeSheet = {
    getLastRow: () => 4,
    getRange: (row, col, numRows, numCols) => {
      assert.equal(col, 8); // Dedupe Key column
      const out = [];
      for (let r = row; r < row + numRows; r++) out.push(values[r] !== undefined ? values[r] : ['']);
      return { getValues: () => out };
    }
  };
  const keys = gas.readExistingCrmOrganizationReviewKeys_(fakeSheet);
  assert.deepEqual(Array.from(keys), ['pipeline:cold calling 2', 'assignee:j3b1n9nwtdvglylgbcji']);
});

test('readExistingCrmOrganizationReviewKeys_ returns an empty list for a brand-new sheet', () => {
  assert.deepEqual(Array.from(gas.readExistingCrmOrganizationReviewKeys_({ getLastRow: () => 1 })), []);
});

// ---------------------------------------------------------------------------
// Real bug found live (06/09/2026): "Unrecognized assignee" findings showed
// raw GHL user IDs ("j3B1N9nwTDvgLyLgbcjI") instead of a name — useless for
// Tomás to act on without looking each one up himself. buildGhlUserNameLookup_
// / resolveGhlAssigneeLabel_ resolve IDs against a fetched user list instead.
// ---------------------------------------------------------------------------

test('buildGhlUserNameLookup_ maps user ID to a display name, preferring name, then first+last, then email', () => {
  const lookup = gas.buildGhlUserNameLookup_([
    { id: 'u1', name: 'Sean Church' },
    { id: 'u2', firstName: 'Joana', lastName: 'Peixe' },
    { id: 'u3', email: 'tomas@iconsofrealestate.com' },
    { id: 'u4' } // no usable name at all — should not appear in the lookup
  ]);
  assert.equal(lookup.u1, 'Sean Church');
  assert.equal(lookup.u2, 'Joana Peixe');
  assert.equal(lookup.u3, 'tomas@iconsofrealestate.com');
  assert.equal(lookup.u4, undefined);
});

test('buildGhlUserNameLookup_ returns an empty lookup for null/empty input rather than throwing — the fetch failed (missing scope) case', () => {
  assert.equal(Object.keys(gas.buildGhlUserNameLookup_(null)).length, 0);
  assert.equal(Object.keys(gas.buildGhlUserNameLookup_([])).length, 0);
});

test('resolveGhlAssigneeLabel_ resolves a known ID to the bare name — no ID suffix (Kris, 06/09/2026: "Don\'t need the big long number. No one knows what that is")', () => {
  const lookup = { j3B1N9nwTDvgLyLgbcjI: 'Sean Church' };
  assert.equal(gas.resolveGhlAssigneeLabel_('j3B1N9nwTDvgLyLgbcjI', lookup), 'Sean Church');
});

test('resolveGhlAssigneeLabel_ falls back to a clearly-labeled raw ID when the lookup has nothing for it (missing scope, or a user GHL didn\'t return) — the ID is kept ONLY here, since it\'s the one case a human could actually use it to look the user up', () => {
  assert.equal(gas.resolveGhlAssigneeLabel_('j3B1N9nwTDvgLyLgbcjI', {}), 'Unknown user (j3B1N9nwTDvgLyLgbcjI)');
  assert.equal(gas.resolveGhlAssigneeLabel_('j3B1N9nwTDvgLyLgbcjI', null), 'Unknown user (j3B1N9nwTDvgLyLgbcjI)');
});

// ---------------------------------------------------------------------------
// One-time repair (06/09/2026, extended same day): Tomás, live, on a raw-ID
// "Unrecognized assignee" row: "how the fuck can he answer this?" — rows
// written before resolveGhlAssigneeLabel_ existed still show the bare GHL
// user ID. Then Kris, on a row that WAS resolved but still showed the ID in
// parentheses: "Don't need the big long number. No one knows what that is."
// repairedUnrecognizedAssigneeFinding_ handles all three shapes this data
// has actually been in live; repairCrmOrganizationReviewAssigneeNames_
// applies it in place rather than re-scanning (which would just add
// duplicate rows, since previewCrmOrganizationReview_ has no
// dedupe-by-content check).
// ---------------------------------------------------------------------------

test('repairedUnrecognizedAssigneeFinding_ resolves the legacy quoted-raw-ID shape to a bare name, dropping the ID entirely', () => {
  const lookup = { wEL0kebR7naWq9aTx7CW: 'Joana Peixe' };
  const result = gas.repairedUnrecognizedAssigneeFinding_(
    '"wEL0kebR7naWq9aTx7CW" is assigned 48 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)',
    lookup
  );
  assert.equal(result, 'Joana Peixe is assigned 48 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)');
});

test('repairedUnrecognizedAssigneeFinding_ retries the "Unknown user (id)" fallback shape once a name becomes available', () => {
  const lookup = { wEL0kebR7naWq9aTx7CW: 'Joana Peixe' };
  const result = gas.repairedUnrecognizedAssigneeFinding_(
    'Unknown user (wEL0kebR7naWq9aTx7CW) is assigned 48 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)',
    lookup
  );
  assert.equal(result, 'Joana Peixe is assigned 48 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)');
});

test('repairedUnrecognizedAssigneeFinding_ returns null for "Unknown user (id)" when the lookup still has nothing — no needless rewrite', () => {
  assert.equal(gas.repairedUnrecognizedAssigneeFinding_(
    'Unknown user (wEL0kebR7naWq9aTx7CW) is assigned 48 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)',
    {}
  ), null);
});

test('repairedUnrecognizedAssigneeFinding_ strips a lingering "(id)" from an already-resolved real name WITHOUT touching the lookup — an incomplete later fetch must never downgrade a good name to "Unknown user"', () => {
  const result = gas.repairedUnrecognizedAssigneeFinding_(
    'Piero Bengoa (qd9XH799VItEYafFdXIV) is assigned 31 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)',
    {} // deliberately empty/incomplete — must not matter for this shape
  );
  assert.equal(result, 'Piero Bengoa is assigned 31 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)');
});

test('repairedUnrecognizedAssigneeFinding_ returns null for a "Pipeline health" Finding — must never touch the other category', () => {
  assert.equal(gas.repairedUnrecognizedAssigneeFinding_(
    '"Cold Calling 2" — 100% of open opportunities (100 of 100) sit in one stage: "Qualification Call Booked"', {}
  ), null);
});

test('repairCrmOrganizationReviewAssigneeNames_ rewrites legacy and lingering-ID Finding cells, leaving Pipeline health rows untouched', () => {
  const written = { value: null };
  const fakeSheet = {
    getLastRow: () => 4,
    getRange: (row, col, numRows, numCols) => {
      assert.equal(col, 3); // Finding column
      return {
        getValues: () => [
          ['"wEL0kebR7naWq9aTx7CW" is assigned 48 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)'],
          ['"Cold Calling 2" — 100% of open opportunities (100 of 100) sit in one stage: "Qualification Call Booked"'],
          ['Piero Bengoa (qd9XH799VItEYafFdXIV) is assigned 31 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)']
        ],
        setValues: (vals) => { written.value = vals; }
      };
    }
  };
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  const originalGhlCheckSetup = gas.ghlCheckSetup_;
  const originalFetchUsers = gas.fetchGhlLocationUsers_;
  gas.SpreadsheetApp = { openById: () => ({ getSheetByName: () => fakeSheet }) };
  gas.ghlCheckSetup_ = () => 'loc123';
  // Deliberately does NOT include Piero Bengoa's ID — proves case 3 (an
  // already-resolved name) never depends on this fetch coming back complete.
  gas.fetchGhlLocationUsers_ = () => [{ id: 'wEL0kebR7naWq9aTx7CW', name: 'Joana Peixe' }];
  try {
    gas.repairCrmOrganizationReviewAssigneeNames_();
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
    gas.ghlCheckSetup_ = originalGhlCheckSetup;
    gas.fetchGhlLocationUsers_ = originalFetchUsers;
  }
  assert.ok(written.value, 'the Finding column should have been written back');
  assert.equal(written.value[0][0], 'Joana Peixe is assigned 48 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)');
  assert.equal(written.value[1][0], '"Cold Calling 2" — 100% of open opportunities (100 of 100) sit in one stage: "Qualification Call Booked"');
  assert.equal(written.value[2][0], 'Piero Bengoa is assigned 31 open opportunity(ies) but is not in CONFIG.REPS or the known-old-reps list (Bruno/Simon/Ty)');
});


// ---------------------------------------------------------------------------
// Phase16_CalibrationFeedback.gs — Kris's ask (06/09/2026): "I want the code
// to automatically pick up my training, send email to the rep with my
// feedback and link to my recording. Incorporate what I say into the
// training plan for the coming week." Confirmed live: he drops raw videos
// straight into each rep's Drive folder with no sheet interaction at all —
// this phase is Drive-folder-driven end to end (video -> transcript, dropped
// by tools/transcribe_calibration_feedback.py -> judged -> emailed -> merged
// into the same TRAINING_* properties Phase 6/7 already use).
// ---------------------------------------------------------------------------

function fakeCalibrationVideoFile_(name, opts) {
  opts = opts || {};
  return {
    getName: () => name,
    getMimeType: () => opts.mimeType || 'video/mp4',
    getUrl: () => opts.url || ('https://drive.google.com/file/d/' + name),
    getDateCreated: () => opts.dateCreated || new Date(2026, 8, 6)
  };
}

/** files: array of { name, mimeType }. Mirrors the getFiles()/getFilesByName() fake pattern used by Phase 7's tests above. */
function fakeCalibrationFolder_(files) {
  return {
    getFiles: () => {
      let i = 0;
      return {
        hasNext: () => i < files.length,
        next: () => { const f = files[i]; i++; return fakeCalibrationVideoFile_(f.name, f); }
      };
    },
    getFilesByName: (wanted) => {
      const exists = files.some((f) => f.name === wanted);
      let served = false;
      return { hasNext: () => exists && !served, next: () => { served = true; return fakeCalibrationVideoFile_(wanted, { mimeType: 'application/vnd.google-apps.document' }); } };
    }
  };
}

test('collectCalibrationFeedbackVideos_ returns only video/* files from a folder, ignoring transcript/marker Docs already sitting there', () => {
  const folder = fakeCalibrationFolder_([
    { name: 'Julio Lopez.mp4', mimeType: 'video/mp4' },
    { name: 'Julio Lopez.mp4 — Transcript', mimeType: 'application/vnd.google-apps.document' },
    { name: 'Reba Miller.mov', mimeType: 'video/quicktime' }
  ]);
  const videos = Array.prototype.slice.call(gas.collectCalibrationFeedbackVideos_(folder)).map((f) => f.getName());
  assert.deepEqual(videos.sort(), ['Julio Lopez.mp4', 'Reba Miller.mov']);
});

test('findCalibrationFeedbackTranscript_ finds the exact "<video name> — Transcript" sibling, trimming trailing whitespace in the video name (matches tools/transcribe_*.py\'s title_fn convention)', () => {
  const folder = fakeCalibrationFolder_([
    { name: 'Julio Lopez.mp4 — Transcript', mimeType: 'application/vnd.google-apps.document' }
  ]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4 '); // trailing space, as real Drive filenames sometimes have
  const found = gas.findCalibrationFeedbackTranscript_(folder, video);
  assert.ok(found, 'expected the transcript sibling to be found despite trailing whitespace');
});

test('findCalibrationFeedbackTranscript_ returns null when no transcript exists yet — the driver must wait for tools/transcribe_calibration_feedback.py, not fail', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4');
  assert.equal(gas.findCalibrationFeedbackTranscript_(folder, video), null);
});

test('calibrationFeedbackAlreadySent_ is true only once the "<video name> — Feedback Sent" marker exists', () => {
  const sentFolder = fakeCalibrationFolder_([{ name: 'Julio Lopez.mp4 — Feedback Sent', mimeType: 'application/vnd.google-apps.document' }]);
  const pendingFolder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4');
  assert.equal(gas.calibrationFeedbackAlreadySent_(sentFolder, video), true);
  assert.equal(gas.calibrationFeedbackAlreadySent_(pendingFolder, video), false);
});

test('isValidCalibrationFeedbackSchema_ accepts a well-formed result including a null close_ask_drill and empty arrays', () => {
  assert.equal(gas.isValidCalibrationFeedbackSchema_({
    headline: 'Never asked for the money directly.',
    feedback_points: ['Good discovery, but let the objection sit unanswered.'],
    objections_to_drill: [{ label: 'too busy', note: 'agree, isolate, repeat' }],
    close_ask_drill: null,
    framework_gaps_to_drill: []
  }), true);
});

test('isValidCalibrationFeedbackSchema_ rejects missing/malformed fields', () => {
  assert.equal(gas.isValidCalibrationFeedbackSchema_(null), false);
  assert.equal(gas.isValidCalibrationFeedbackSchema_({ feedback_points: [], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] }), false, 'missing headline');
  assert.equal(gas.isValidCalibrationFeedbackSchema_({ headline: 'x', objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] }), false, 'missing feedback_points');
  assert.equal(gas.isValidCalibrationFeedbackSchema_({
    headline: 'x', feedback_points: [1, 2], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: []
  }), false, 'feedback_points entries must be strings');
  assert.equal(gas.isValidCalibrationFeedbackSchema_({
    headline: 'x', feedback_points: [], objections_to_drill: [{ label: 'x' }], close_ask_drill: null, framework_gaps_to_drill: []
  }), false, 'objection missing note');
});

test('gradeCalibrationFeedbackTranscript_ falls back to a safe "watch the recording" headline and all-empty drill fields when the judge model never returns parseable JSON', () => {
  const originalConfig = gas.PHASE2_CONFIG;
  const originalCallKimiJudge = gas.callKimiJudge_;
  try {
    gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 0 };
    gas.callKimiJudge_ = () => 'not json';
    const result = gas.gradeCalibrationFeedbackTranscript_('Sean', 'Julio Lopez.mp4', 'some transcript');
    assert.equal(typeof result.headline, 'string');
    assert.ok(result.headline.length > 0);
    assert.equal(result.feedback_points.length, 0);
    assert.equal(result.objections_to_drill.length, 0);
    assert.equal(result.close_ask_drill, null);
    assert.equal(result.framework_gaps_to_drill.length, 0);
  } finally {
    gas.PHASE2_CONFIG = originalConfig;
    gas.callKimiJudge_ = originalCallKimiJudge;
  }
});

test('calibrationFeedbackDisplayTitle_ strips the extension and a leading "<rep> " prefix for a clean display name (Kris\'s complaint 06/09/2026: the email showed the raw filename verbatim and "looks bad")', () => {
  assert.equal(gas.calibrationFeedbackDisplayTitle_('Sean Margaret Bruno.mp4', 'Sean'), 'Margaret Bruno');
  assert.equal(gas.calibrationFeedbackDisplayTitle_('Joana - Jason Pietruszka.mp4', 'Joana'), 'Jason Pietruszka');
  assert.equal(gas.calibrationFeedbackDisplayTitle_('Julio Lopez.mp4', 'Sean'), 'Julio Lopez', 'no rep prefix to strip must leave the name as-is (minus extension)');
});

test('calibrationFeedbackDrillSummaryLines_ lists every drill topic just merged, empty when nothing was extracted', () => {
  assert.deepEqual(Array.prototype.slice.call(gas.calibrationFeedbackDrillSummaryLines_({
    objections_to_drill: [{ label: 'too busy', note: 'agree, isolate, repeat' }],
    close_ask_drill: { label: 'Ready to get started?', note: 'ask twice' },
    framework_gaps_to_drill: [{ topic: 'sell_more_houses', note: 'name a concrete case study' }]
  })), [
    'Objection — too busy: agree, isolate, repeat',
    'Close ask — Ready to get started?: ask twice',
    'Framework (Sell more houses) — name a concrete case study'
  ]);
  assert.equal(gas.calibrationFeedbackDrillSummaryLines_({ objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] }).length, 0);
});

test('buildCalibrationFeedbackEmail_ includes the video link, recorded date, bold headline, bulleted feedback points, and what was added to the practice plan', () => {
  const graded = {
    headline: 'Never asked for the money directly.',
    feedback_points: ['Good discovery.', '"I guess we could talk price" — you let that sit instead of isolating it.'],
    objections_to_drill: [{ label: 'too busy', note: 'agree, isolate, repeat' }],
    close_ask_drill: null,
    framework_gaps_to_drill: []
  };
  const email = gas.buildCalibrationFeedbackEmail_('Sean', 'Sean Julio Lopez.mp4',
    'https://drive.google.com/file/d/abc123', '06/09/2026', graded);
  assert.match(email.subject, /Julio Lopez/);
  assert.ok(email.body.indexOf('recorded 06/09/2026') !== -1);
  assert.ok(email.body.indexOf('https://drive.google.com/file/d/abc123') !== -1);
  assert.ok(email.body.indexOf('Never asked for the money directly.') !== -1);
  assert.ok(email.body.indexOf('• Good discovery.') !== -1, 'feedback points must render as bullets in plain text');
  assert.ok(email.body.indexOf('Added to your practice plan this week:') !== -1);
  assert.ok(email.body.indexOf('Objection — too busy: agree, isolate, repeat') !== -1);

  assert.match(email.htmlBody, /href="https:\/\/drive\.google\.com\/file\/d\/abc123"/);
  assert.ok(email.htmlBody.indexOf('recorded 06/09/2026') !== -1);
  assert.ok(email.htmlBody.indexOf('<strong>') !== -1 && email.htmlBody.indexOf('Never asked for the money directly.') !== -1,
    'the headline must be bolded');
  assert.ok(email.htmlBody.indexOf('<ul') !== -1 && email.htmlBody.indexOf('<li>Good discovery.</li>') !== -1,
    'feedback points must render as a real bulleted list');
  assert.ok(email.htmlBody.indexOf('<i>&quot;I guess we could talk price&quot;</i>') !== -1,
    'quoted excerpts within a feedback point must be italicized');
  assert.ok(email.htmlBody.indexOf('<li>Objection — too busy: agree, isolate, repeat</li>') !== -1,
    'the practice-plan addition must be listed too');
});

test('buildCalibrationFeedbackEmail_ says plainly when nothing new was added to the practice plan', () => {
  const graded = { headline: 'Solid call, nothing to flag.', feedback_points: [], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] };
  const email = gas.buildCalibrationFeedbackEmail_('Sean', 'Sean Julio Lopez.mp4', 'https://drive.google.com/x', '06/09/2026', graded);
  assert.ok(email.body.indexOf('(nothing new this time)') !== -1);
  assert.ok(email.htmlBody.indexOf('(nothing new this time)') !== -1);
});

test('buildCalibrationFeedbackEmail_ escapes HTML in the headline/feedback points so a "<...>" artifact can\'t render as invisible markup (same bug class as the /review/decide escaping fix)', () => {
  const graded = { headline: 'Said "<script>bad</script>" at 04:12', feedback_points: [], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] };
  const email = gas.buildCalibrationFeedbackEmail_('Sean', 'Julio Lopez.mp4', 'https://drive.google.com/x', '06/09/2026', graded);
  assert.ok(email.htmlBody.indexOf('<script>bad</script>') === -1, 'raw script tag must not appear unescaped');
  assert.ok(email.htmlBody.indexOf('&lt;script&gt;') !== -1);
});

test('mergeCalibrationDrillIntoTrainingProperties_ only overwrites TRAINING_* properties when this round\'s extraction is non-empty, never wiping out a prior week\'s assignment (same non-destructive rule as processTrainingTranscript_)', () => {
  const store = { 'TRAINING_OBJECTIONS_Sean': JSON.stringify([{ label: 'old objection', note: 'old note' }]) };
  gas.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) };
  const originalMirror = gas.mirrorTrainingAssignment_;
  const mirrored = [];
  gas.mirrorTrainingAssignment_ = (rep) => mirrored.push(rep);
  try {
    gas.mergeCalibrationDrillIntoTrainingProperties_('Sean', { objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] });
    assert.equal(store['TRAINING_OBJECTIONS_Sean'], JSON.stringify([{ label: 'old objection', note: 'old note' }]));
    assert.equal(store['TRAINING_CLOSE_DRILL_Sean'], undefined);
    assert.deepEqual(mirrored, ['Sean'], 'mirrorTrainingAssignment_ must still run so the dashboard reflects the (unchanged) current assignment');

    gas.mergeCalibrationDrillIntoTrainingProperties_('Sean', {
      objections_to_drill: [{ label: 'new objection', note: 'new note' }],
      close_ask_drill: { label: 'Ready to get started?', note: 'ask twice' },
      framework_gaps_to_drill: []
    });
    assert.equal(store['TRAINING_OBJECTIONS_Sean'], JSON.stringify([{ label: 'new objection', note: 'new note' }]));
    assert.equal(store['TRAINING_CLOSE_DRILL_Sean'], JSON.stringify({ label: 'Ready to get started?', note: 'ask twice' }));
  } finally {
    gas.mirrorTrainingAssignment_ = originalMirror;
  }
});

test('detectCalibrationFolderMisfile_ flags a transcript that names a different rep repeatedly and never names the folder\'s own rep (the real "2 of Tomas\'s calls landed in Bens\'s folder" bug)', () => {
  const transcript = "Tomas, on this call you did a great job with discovery. Tomas asked good questions but Tomas never asked for the close.";
  const result = gas.detectCalibrationFolderMisfile_('Bens', transcript);
  assert.equal(result.suspected, true);
  assert.equal(result.suspectedRep, 'Tomás', 'must resolve the unaccented "Tomas" transcription to the real rep name');
  assert.equal(result.mentionCount, 3);
});

test('detectCalibrationFolderMisfile_ does not flag a normal recording that mentions the folder\'s own rep by name', () => {
  const transcript = "Bens, great energy on this recording. Bens really nailed the framework explanation.";
  const result = gas.detectCalibrationFolderMisfile_('Bens', transcript);
  assert.equal(result.suspected, false);
});

test('detectCalibrationFolderMisfile_ does not flag a single incidental mention of another rep (not the whole video being about them)', () => {
  const transcript = "Good discovery on this call. Reminded me a bit of how Sean handled a similar objection last week.";
  const result = gas.detectCalibrationFolderMisfile_('Bens', transcript);
  assert.equal(result.suspected, false, 'one passing mention of another rep should not trigger a false positive');
});

test('detectCalibrationFolderMisfile_ does not flag a transcript that names neither the folder\'s rep nor any other rep', () => {
  const transcript = "Good energy on this call, but never asked for the close. Work on that this week.";
  const result = gas.detectCalibrationFolderMisfile_('Sean', transcript);
  assert.equal(result.suspected, false);
});

test('processCalibrationFeedbackVideo_ skips a likely-misfiled video (names a different rep, not this one) rather than emailing the wrong feedback to the wrong rep', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4');
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };
  const originalGetTranscriptText = gas.getTranscriptText_;
  const originalGrade = gas.gradeCalibrationFeedbackTranscript_;
  const originalGuardedSend = gas.guardedSend_;
  const originalMerge = gas.mergeCalibrationDrillIntoTrainingProperties_;
  gas.getTranscriptText_ = () => "Tomas, great job on this call. Tomas really handled that objection well.";
  gas.gradeCalibrationFeedbackTranscript_ = () => { throw new Error('must not even call the judge on a suspected misfile — save the cost'); };
  gas.guardedSend_ = () => { throw new Error('must not send — suspected misfile'); };
  gas.mergeCalibrationDrillIntoTrainingProperties_ = () => { throw new Error('must not merge — suspected misfile'); };
  try {
    const didWork = gas.processCalibrationFeedbackVideo_('Bens', folder, video, transcriptFile, false);
    assert.equal(didWork, false);
  } finally {
    gas.getTranscriptText_ = originalGetTranscriptText;
    gas.gradeCalibrationFeedbackTranscript_ = originalGrade;
    gas.guardedSend_ = originalGuardedSend;
    gas.mergeCalibrationDrillIntoTrainingProperties_ = originalMerge;
  }
});

test('processCalibrationFeedbackVideo_ emails the rep, merges drill topics, and drops a "Feedback Sent" marker only after a successful send', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4', { url: 'https://drive.google.com/file/d/xyz' });
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };

  const originalGetTranscriptText = gas.getTranscriptText_;
  const originalGrade = gas.gradeCalibrationFeedbackTranscript_;
  const originalGuardedSend = gas.guardedSend_;
  const originalMerge = gas.mergeCalibrationDrillIntoTrainingProperties_;
  const originalDocumentApp = gas.DocumentApp;
  const originalDriveApp = gas.DriveApp;
  const originalUtilities = gas.Utilities;

  let sendArgs = null;
  let mergeArgs = null;
  const movedMarkers = [];
  gas.getTranscriptText_ = () => 'Kris\'s spoken feedback transcript text';
  gas.gradeCalibrationFeedbackTranscript_ = () => ({
    headline: 'Good energy, ask for the money directly next time.',
    feedback_points: [], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: []
  });
  gas.guardedSend_ = (...args) => { sendArgs = args; return true; };
  gas.mergeCalibrationDrillIntoTrainingProperties_ = (rep, graded) => { mergeArgs = [rep, graded]; };
  const fakeMarkerDoc = { getBody: () => ({ setText: () => {} }), saveAndClose: () => {}, getId: () => 'marker-id' };
  gas.DocumentApp = { create: () => fakeMarkerDoc };
  gas.DriveApp = { getFileById: (id) => ({ moveTo: (f) => movedMarkers.push({ id, folder: f }) }) };
  gas.Utilities = { formatDate: () => '06/09/2026' };

  try {
    const didWork = gas.processCalibrationFeedbackVideo_('Sean', folder, video, transcriptFile, false);
    assert.equal(didWork, true);
    assert.equal(sendArgs[0], 'sean@iconsofrealestate.com', 'must send to Sean\'s real CONFIG.REPS email');
    assert.ok(sendArgs[1].indexOf('Julio Lopez') !== -1, 'subject must reference the recording');
    assert.deepEqual(mergeArgs[0], 'Sean');
    assert.equal(movedMarkers.length, 1, 'the Feedback Sent marker must be moved into the rep\'s folder');
    assert.equal(movedMarkers[0].folder, folder);
  } finally {
    gas.getTranscriptText_ = originalGetTranscriptText;
    gas.gradeCalibrationFeedbackTranscript_ = originalGrade;
    gas.guardedSend_ = originalGuardedSend;
    gas.mergeCalibrationDrillIntoTrainingProperties_ = originalMerge;
    gas.DocumentApp = originalDocumentApp;
    gas.DriveApp = originalDriveApp;
    gas.Utilities = originalUtilities;
  }
});

test('processCalibrationFeedbackVideo_ never merges or marks sent when guardedSend_ fails (quota-short) — video must stay pending for the next run', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4');
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };
  const originalGetTranscriptText = gas.getTranscriptText_;
  const originalGrade = gas.gradeCalibrationFeedbackTranscript_;
  const originalGuardedSend = gas.guardedSend_;
  const originalMerge = gas.mergeCalibrationDrillIntoTrainingProperties_;
  const originalUtilities = gas.Utilities;
  gas.getTranscriptText_ = () => FAKE_TRANSCRIPT_;
  gas.gradeCalibrationFeedbackTranscript_ = () => ({ headline: 'x', feedback_points: [], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] });
  gas.guardedSend_ = () => false;
  gas.mergeCalibrationDrillIntoTrainingProperties_ = () => { throw new Error('must not merge — send failed'); };
  gas.Utilities = { formatDate: () => '06/09/2026' };
  try {
    const didWork = gas.processCalibrationFeedbackVideo_('Sean', folder, video, transcriptFile, false);
    assert.equal(didWork, false);
  } finally {
    gas.getTranscriptText_ = originalGetTranscriptText;
    gas.gradeCalibrationFeedbackTranscript_ = originalGrade;
    gas.guardedSend_ = originalGuardedSend;
    gas.mergeCalibrationDrillIntoTrainingProperties_ = originalMerge;
    gas.Utilities = originalUtilities;
  }
});

test('processCalibrationFeedbackVideo_ in dry-run logs but never sends, merges, or writes', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4');
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };
  const originalGetTranscriptText = gas.getTranscriptText_;
  const originalGrade = gas.gradeCalibrationFeedbackTranscript_;
  const originalGuardedSend = gas.guardedSend_;
  const originalUtilities = gas.Utilities;
  gas.getTranscriptText_ = () => FAKE_TRANSCRIPT_;
  gas.guardedSend_ = () => { throw new Error('must not send in dry-run'); };
  gas.Utilities = { formatDate: () => '06/09/2026' };
  try {
    // gradeCalibrationFeedbackTranscript_ IS called before the dryRun check (it builds the
    // preview email body), so stub it to succeed and only assert nothing downstream fires.
    gas.gradeCalibrationFeedbackTranscript_ = () => ({ headline: 'x', feedback_points: [], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] });
    const didWork = gas.processCalibrationFeedbackVideo_('Sean', folder, video, transcriptFile, true);
    assert.equal(didWork, false);
  } finally {
    gas.getTranscriptText_ = originalGetTranscriptText;
    gas.gradeCalibrationFeedbackTranscript_ = originalGrade;
    gas.guardedSend_ = originalGuardedSend;
    gas.Utilities = originalUtilities;
  }
});

test('processCalibrationFeedbackVideo_ skips a video with no known rep email rather than throwing or sending to nobody', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Julio Lopez.mp4');
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };
  const originalGuardedSend = gas.guardedSend_;
  gas.guardedSend_ = () => { throw new Error('must not send — no known rep email'); };
  try {
    const didWork = gas.processCalibrationFeedbackVideo_('Some Old Rep', folder, video, transcriptFile, false);
    assert.equal(didWork, false);
  } finally {
    gas.guardedSend_ = originalGuardedSend;
  }
});

test('buildAndMaybeSendCalibrationFeedback_ skips a video with no transcript yet and one already marked sent, only processing the one genuinely pending video', () => {
  const folders = {
    Sean: fakeCalibrationFolder_([
      { name: 'No Transcript Yet.mp4', mimeType: 'video/mp4' },
      { name: 'Already Sent.mp4', mimeType: 'video/mp4' },
      { name: 'Already Sent.mp4 — Feedback Sent', mimeType: 'application/vnd.google-apps.document' },
      { name: 'Pending.mp4', mimeType: 'video/mp4' },
      { name: 'Pending.mp4 — Transcript', mimeType: 'application/vnd.google-apps.document' }
    ])
  };
  const originalConfig = gas.CALIBRATION_FEEDBACK_CONFIG;
  const originalDriveApp = gas.DriveApp;
  const originalProcess = gas.processCalibrationFeedbackVideo_;
  const processed = [];
  gas.CALIBRATION_FEEDBACK_CONFIG = { ENABLED: false, TRIGGER_HOUR: 9, FOLDERS: { Sean: 'sean-folder-id' } };
  gas.DriveApp = { getFolderById: (id) => folders.Sean };
  gas.processCalibrationFeedbackVideo_ = (rep, folder, videoFile) => { processed.push(videoFile.getName()); return true; };
  try {
    const count = gas.buildAndMaybeSendCalibrationFeedback_(false);
    assert.deepEqual(processed, ['Pending.mp4']);
    assert.equal(count, 1);
  } finally {
    gas.CALIBRATION_FEEDBACK_CONFIG = originalConfig;
    gas.DriveApp = originalDriveApp;
    gas.processCalibrationFeedbackVideo_ = originalProcess;
  }
});

test('sendUpcomingLeadConfirmationReminders_ CCs Tomás on the rep-facing reminder (Kris\'s ask 06/09/2026: "CC Tomas on all the emails sent to reps") — real gap found live: this send had no CC at all', () => {
  const originalLockService = gas.LockService;
  const originalConfig = gas.LEAD_CONFIRMATION_CONFIG;
  const originalFindEvents = gas.findUpcomingDiscoveryCallsForRep_;
  const originalHasSent = gas.hasLeadConfirmationReminderBeenSent_;
  const originalMarkSent = gas.markLeadConfirmationReminderSent_;
  const originalGuardedSend = gas.guardedSend_;
  const originalRepsConfig = gas.CONFIG.REPS;
  let sendArgs = null;
  gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  gas.LEAD_CONFIRMATION_CONFIG = { ENABLED: true, LOOKAHEAD_MIN_HOURS: 22, LOOKAHEAD_MAX_HOURS: 26 };
  gas.CONFIG.REPS = [{ name: 'Sean', email: 'sean@iconsofrealestate.com' }];
  gas.findUpcomingDiscoveryCallsForRep_ = () => [{ id: 'evt1', title: 'Discovery — Jane Doe', prospectGuess: 'Jane Doe', start: new Date() }];
  gas.hasLeadConfirmationReminderBeenSent_ = () => false;
  gas.markLeadConfirmationReminderSent_ = () => {};
  gas.guardedSend_ = (...args) => { sendArgs = args; return true; };
  try {
    gas.sendUpcomingLeadConfirmationReminders_();
    assert.ok(sendArgs, 'expected guardedSend_ to be called');
    assert.equal(sendArgs[0], 'sean@iconsofrealestate.com');
    assert.equal(sendArgs[3].cc, gas.CONFIG.TOMAS_EMAIL);
  } finally {
    gas.LockService = originalLockService;
    gas.LEAD_CONFIRMATION_CONFIG = originalConfig;
    gas.findUpcomingDiscoveryCallsForRep_ = originalFindEvents;
    gas.hasLeadConfirmationReminderBeenSent_ = originalHasSent;
    gas.markLeadConfirmationReminderSent_ = originalMarkSent;
    gas.guardedSend_ = originalGuardedSend;
    gas.CONFIG.REPS = originalRepsConfig;
  }
});

test('softenProfanityForJudge_ replaces the handful of words most likely to trip a content filter, case-insensitively, whole-word only', () => {
  const out = gas.softenProfanityForJudge_("Don't fucking send people links. That's bullshit, ass advice, damn it.");
  assert.ok(out.indexOf('fucking') === -1 && out.indexOf('bullshit') === -1);
  assert.ok(out.toLowerCase().indexOf('shitake') === -1); // sanity: nothing to mangle here, but confirms no accidental substring match
  assert.match(out, /Don't really send people links/i);
});

test('softenProfanityForJudge_ does not mangle a word that merely contains a profane substring (whole-word boundaries)', () => {
  const out = gas.softenProfanityForJudge_('The shiitake mushroom dish was a classic.');
  assert.equal(out, 'The shiitake mushroom dish was a classic.');
});

test('gradeCalibrationFeedbackTranscript_ retries with softened language after a content_filter rejection, and succeeds if the softened retry gets through (real bug 06/09/2026: Kris\'s genuinely profane coaching style got rejected by the LiteLLM proxy as "high risk" — plain retry resent the identical text and failed identically twice)', () => {
  const originalConfig = gas.PHASE2_CONFIG;
  const originalCallKimiJudge = gas.callKimiJudge_;
  const promptsSeen = [];
  try {
    gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 1 };
    let call = 0;
    gas.callKimiJudge_ = (systemPrompt, userPrompt) => {
      promptsSeen.push(userPrompt);
      call++;
      if (call === 1) {
        throw new Error('LlmTransportError_: LiteLLM proxy HTTP 400: {"error":{"code":400,"message":"The request was rejected because it was considered high risk","param":"prompt","type":"content_filter"}}');
      }
      return JSON.stringify({ headline: 'Good energy, ask for the close directly.', feedback_points: [], objections_to_drill: [], close_ask_drill: null, framework_gaps_to_drill: [] });
    };
    const result = gas.gradeCalibrationFeedbackTranscript_('Sean', 'Julio Lopez.mp4', "don't fucking send people links, that's bullshit");
    assert.equal(result.headline, 'Good energy, ask for the close directly.');
    assert.equal(promptsSeen.length, 2);
    assert.ok(promptsSeen[0].indexOf('fucking') !== -1, 'first attempt must send the real transcript, unmodified');
    assert.ok(promptsSeen[1].indexOf('fucking') === -1, 'second attempt must send the softened transcript, not the identical rejected text');
    assert.ok(promptsSeen[1].indexOf('really') !== -1);
  } finally {
    gas.PHASE2_CONFIG = originalConfig;
    gas.callKimiJudge_ = originalCallKimiJudge;
  }
});

test('gradeCalibrationFeedbackTranscript_ still falls back safely when even the softened retry fails', () => {
  const originalConfig = gas.PHASE2_CONFIG;
  const originalCallKimiJudge = gas.callKimiJudge_;
  try {
    gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 1 };
    gas.callKimiJudge_ = () => {
      throw new Error('LlmTransportError_: LiteLLM proxy HTTP 400: {"error":{"code":400,"message":"high risk","type":"content_filter"}}');
    };
    const result = gas.gradeCalibrationFeedbackTranscript_('Sean', 'Julio Lopez.mp4', 'fucking bullshit transcript');
    assert.ok(result.headline.indexOf('watch the recording directly') !== -1);
    assert.equal(result.feedback_points.length, 0);
    assert.equal(result.objections_to_drill.length, 0);
  } finally {
    gas.PHASE2_CONFIG = originalConfig;
    gas.callKimiJudge_ = originalCallKimiJudge;
  }
});

// ---------------------------------------------------------------------------
// Phase17_SeanFollowUpAutomation.gs — "Automating Follow-Ups for Sean —
// Plan (v2)" (Google Doc, 03/09/2026). Blocked end to end on the
// gmail.compose scope propagating and a real handoff-email example from
// Kris (see the file's own header) — these tests cover the pure scheduling
// math, dead-label check, and tracker sheet that don't depend on either.
// ---------------------------------------------------------------------------

function assertBusinessTzInstant_(d, expected) {
  assert.equal(realFormatDate(d, 'America/New_York', 'yyyy'), String(expected.year));
  assert.equal(realFormatDate(d, 'America/New_York', 'MM'), String(expected.month).padStart(2, '0'));
  assert.equal(realFormatDate(d, 'America/New_York', 'dd'), String(expected.day).padStart(2, '0'));
  assert.equal(realFormatDate(d, 'America/New_York', 'HH'), String(expected.hour).padStart(2, '0'));
  assert.equal(realFormatDate(d, 'America/New_York', 'mm'), String(expected.minute).padStart(2, '0'));
  assert.equal(realFormatDate(d, 'America/New_York', 'ss'), String(expected.second).padStart(2, '0'));
  if (expected.weekday) assert.equal(realFormatDate(d, 'America/New_York', 'EEEE'), expected.weekday);
}

test('dateAtTimeInBusinessTimezone_ builds the requested wall-clock time in CONFIG.BUSINESS_TIMEZONE (America/New_York), not the runtime default', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const d = gas.dateAtTimeInBusinessTimezone_(2026, 9, 10, 14, 30, 0);
  assertBusinessTzInstant_(d, { year: 2026, month: 9, day: 10, hour: 14, minute: 30, second: 0 });
});

test('addBusinessDaysPreservingTimeOfDay_ skips Saturday/Sunday, preserving the exact time of day (the plan doc\'s own "real, specific requirement": "at the same time of day the lead\'s original reply came in," not just N days later whenever the trigger runs)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  // Thursday 03/09/2026, 15:42:10 America/New_York + 2 business days = Monday 07/09/2026 (skips Sat 05/09, Sun 06/09), same time.
  const start = gas.dateAtTimeInBusinessTimezone_(2026, 9, 3, 15, 42, 10);
  const result = gas.addBusinessDaysPreservingTimeOfDay_(start, 2);
  assertBusinessTzInstant_(result, { year: 2026, month: 9, day: 7, hour: 15, minute: 42, second: 10, weekday: 'Monday' });
});

test('addBusinessDaysPreservingTimeOfDay_ handles a span starting on a Friday, landing on the following week (4 business days = breakup email timing)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  // Friday 04/09/2026, 09:00:00 + 4 business days (skips Sat 05, Sun 06) = Thursday 10/09/2026.
  const start = gas.dateAtTimeInBusinessTimezone_(2026, 9, 4, 9, 0, 0);
  const result = gas.addBusinessDaysPreservingTimeOfDay_(start, 4);
  assertBusinessTzInstant_(result, { year: 2026, month: 9, day: 10, hour: 9, minute: 0, second: 0, weekday: 'Thursday' });
});

test('cadence2ReengagementSchedule_ returns all 5 steps (1 week/1/3/6/12 months) anchored to the last call date, in order', () => {
  const schedule = gas.cadence2ReengagementSchedule_(new Date(2026, 0, 15)); // 15 Jan 2026
  const labels = Array.prototype.slice.call(schedule).map((s) => s.label);
  assert.deepEqual(labels, ['1 week', '1 month', '3 months', '6 months', '12 months']);
  assert.equal(schedule[0].dueAt.getDate(), 22); // 15 Jan + 7 days = 22 Jan
  assert.equal(schedule[1].dueAt.getMonth(), 1); // 15 Jan + 1 month = Feb (month index 1)
  assert.equal(schedule[4].dueAt.getFullYear(), 2027); // 15 Jan 2026 + 12 months = Jan 2027
});

test('isThreadMarkedDead_ is true only when the configured dead label is present', () => {
  assert.equal(gas.isThreadMarkedDead_(['Dead']), true);
  assert.equal(gas.isThreadMarkedDead_(['Important', 'Dead', 'Follow-up']), true);
  assert.equal(gas.isThreadMarkedDead_(['Important']), false);
  assert.equal(gas.isThreadMarkedDead_([]), false);
  assert.equal(gas.isThreadMarkedDead_(null), false);
});

test('getOrCreateSeanFollowUpTrackerSheet_ creates the tab with frozen bold headers exactly once, reusing it on a second call', () => {
  const created = [];
  let existingSheet = null;
  const fakeSheet = {
    getRange: () => ({ setValues: () => ({ setFontWeight: () => ({ setBackground: () => {} }) }) }),
    setFrozenRows: () => {}
  };
  const fakeSs = {
    getSheetByName: (name) => { assert.equal(name, 'Sean Follow-Up Tracker'); return existingSheet; },
    insertSheet: (name) => { created.push(name); existingSheet = fakeSheet; return fakeSheet; }
  };
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => fakeSs };
  try {
    const first = gas.getOrCreateSeanFollowUpTrackerSheet_();
    const second = gas.getOrCreateSeanFollowUpTrackerSheet_();
    assert.equal(first, fakeSheet);
    assert.equal(second, fakeSheet);
    assert.deepEqual(created, ['Sean Follow-Up Tracker'], 'must only insert the sheet once');
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

// ---------------------------------------------------------------------------
// Phase17 Cadence 1 handoff detection — Tomás's confirmed answer (07/09/2026):
// "Joana adds Sean to the thread and updates SPAM - Sean. The subject is the
// same of the ongoing email exchange and Sean can see the thread." Detection
// watches Joana's own mailbox (label is per-mailbox) for that label, reusing
// the same Gmail service-account plumbing Phase4/Phase8 already have live.
// ---------------------------------------------------------------------------

test('findGmailLabelId_ finds a label by exact name, case-sensitive as Gmail returns it', () => {
  const originalGmailApiGet = gas.gmailApiGet_;
  gas.gmailApiGet_ = (token, path) => {
    assert.equal(path, '/labels');
    return { labels: [{ id: 'Label_1', name: 'Dead' }, { id: 'Label_2', name: 'SPAM - Sean' }] };
  };
  try {
    assert.equal(gas.findGmailLabelId_('token', 'SPAM - Sean'), 'Label_2');
    assert.equal(gas.findGmailLabelId_('token', 'spam - sean'), null, 'case must match exactly, like Gmail\'s own label names');
    assert.equal(gas.findGmailLabelId_('token', 'Does Not Exist'), null);
  } finally {
    gas.gmailApiGet_ = originalGmailApiGet;
  }
});

test('listThreadIdsByLabelId_ paginates across nextPageToken, same as listInboxThreadIds_', () => {
  const originalGmailApiGet = gas.gmailApiGet_;
  const pathsSeen = [];
  gas.gmailApiGet_ = (token, path) => {
    pathsSeen.push(path);
    if (path.indexOf('pageToken') === -1) return { threads: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' };
    return { threads: [{ id: 'c' }] };
  };
  try {
    const ids = gas.listThreadIdsByLabelId_('token', 'Label_2');
    assert.deepEqual(Array.from(ids), ['a', 'b', 'c']);
    assert.equal(pathsSeen.length, 2);
    assert.ok(pathsSeen[0].indexOf('labelIds=Label_2') !== -1);
  } finally {
    gas.gmailApiGet_ = originalGmailApiGet;
  }
});

test('extractLeadEmailFromParticipants_ returns the one external (non-iconsofrealestate.com) address across From/To/Cc', () => {
  const lead = gas.extractLeadEmailFromParticipants_(
    'Some Lead <lead@example.com>',
    'Sean <sean@iconsofrealestate.com>, Joana <joana@iconsofrealestate.com>',
    ''
  );
  assert.equal(lead, 'lead@example.com');
});

test('extractLeadEmailFromParticipants_ returns null when every participant is internal (never guess a fake lead)', () => {
  const lead = gas.extractLeadEmailFromParticipants_(
    'Joana <joana@iconsofrealestate.com>', 'Sean <sean@iconsofrealestate.com>', ''
  );
  assert.equal(lead, null);
});

test('fetchSeanHandoffThreadInfo_ builds threadId/leadEmail/subject/anchorDate from the thread\'s last message, format=metadata only', () => {
  const originalGmailApiGet = gas.gmailApiGet_;
  let pathSeen = null;
  gas.gmailApiGet_ = (token, path) => {
    pathSeen = path;
    return {
      messages: [{
        internalDate: '1757260800000',
        payload: { headers: [
          { name: 'From', value: 'Lead Person <lead@example.com>' },
          { name: 'To', value: 'sean@iconsofrealestate.com, joana@iconsofrealestate.com' },
          { name: 'Subject', value: 'Re: your podcast strategy call' }
        ] }
      }]
    };
  };
  try {
    const info = gas.fetchSeanHandoffThreadInfo_('token', 'thread-abc');
    assert.equal(info.threadId, 'thread-abc');
    assert.equal(info.leadEmail, 'lead@example.com');
    assert.equal(info.subject, 'Re: your podcast strategy call');
    assert.equal(info.anchorDate.getTime(), 1757260800000);
    assert.ok(pathSeen.indexOf('format=metadata') !== -1, 'must never fetch the full message body');
  } finally {
    gas.gmailApiGet_ = originalGmailApiGet;
  }
});

test('fetchSeanHandoffThreadInfo_ returns null (never throws) for a thread with no external participant', () => {
  const originalGmailApiGet = gas.gmailApiGet_;
  gas.gmailApiGet_ = () => ({
    messages: [{
      internalDate: '1757260800000',
      payload: { headers: [{ name: 'From', value: 'joana@iconsofrealestate.com' }, { name: 'To', value: 'sean@iconsofrealestate.com' }] }
    }]
  });
  try {
    assert.equal(gas.fetchSeanHandoffThreadInfo_('token', 'thread-internal'), null);
  } finally {
    gas.gmailApiGet_ = originalGmailApiGet;
  }
});

test('fetchSeanHandoffThreadInfo_ still finds the lead\'s address when the thread\'s chronologically LAST message is Joana\'s own internal handoff note to Sean (real bug, 07/09/2026 code review: this is exactly the "Gmail thread order is purely chronological, not directional" mistake already made and fixed once for this same mailbox in Phase8_ReplyTracker.gs — trusting only the last message would have silently dropped every handoff whose newest message is Joana\'s internal note)', () => {
  const originalGmailApiGet = gas.gmailApiGet_;
  gas.gmailApiGet_ = () => ({
    messages: [
      {
        internalDate: '1757250000000', // earlier message — has the real lead
        payload: { headers: [
          { name: 'From', value: 'Lead Person <lead@example.com>' },
          { name: 'To', value: 'joana@iconsofrealestate.com' }
        ] }
      },
      {
        internalDate: '1757260800000', // newest message — Joana's internal handoff note, no lead address at all
        payload: { headers: [
          { name: 'From', value: 'joana@iconsofrealestate.com' },
          { name: 'To', value: 'sean@iconsofrealestate.com' },
          { name: 'Subject', value: 'Re: your podcast strategy call' }
        ] }
      }
    ]
  });
  try {
    const info = gas.fetchSeanHandoffThreadInfo_('token', 'thread-mixed');
    assert.ok(info, 'the handoff must still be detected even though the last message has no external participant');
    assert.equal(info.leadEmail, 'lead@example.com');
    // Anchor stays the NEWEST message's timestamp — only the lead-email lookup scans backward, not the anchor.
    assert.equal(info.anchorDate.getTime(), 1757260800000);
  } finally {
    gas.gmailApiGet_ = originalGmailApiGet;
  }
});

test('getTrackedThreadIds_ reads the Thread ID column, empty array when the tracker has no data rows yet', () => {
  const col = gas.SEAN_FOLLOWUP_TRACKER_HEADERS.indexOf('Thread ID') + 1;
  const emptySheet = { getLastRow: () => 1 };
  assert.deepEqual(Array.from(gas.getTrackedThreadIds_(emptySheet)), []);

  const dataSheet = {
    getLastRow: () => 3,
    getRange: (row, c, numRows, numCols) => {
      assert.equal(c, col);
      return { getValues: () => [['thread-1'], ['thread-2']] };
    }
  };
  assert.deepEqual(Array.from(gas.getTrackedThreadIds_(dataSheet)), ['thread-1', 'thread-2']);
});

test('collectNewSeanHandoffThreads_ only returns threads NOT already tracked', () => {
  const originalGetToken = gas.getGmailAccessTokenForUser_;
  const originalGmailApiGet = gas.gmailApiGet_;
  const originalGetSheet = gas.getOrCreateSeanFollowUpTrackerSheet_;
  gas.getGmailAccessTokenForUser_ = () => 'fake-token';
  gas.getOrCreateSeanFollowUpTrackerSheet_ = () => ({
    getLastRow: () => 2,
    getRange: () => ({ getValues: () => [['thread-already-tracked']] })
  });
  gas.gmailApiGet_ = (token, path) => {
    if (path === '/labels') return { labels: [{ id: 'Label_2', name: 'SPAM - Sean' }] };
    if (path.indexOf('/threads?labelIds=') === 0) {
      return { threads: [{ id: 'thread-already-tracked' }, { id: 'thread-new' }] };
    }
    // metadata fetch for thread-new
    return {
      messages: [{
        internalDate: '1757260800000',
        payload: { headers: [
          { name: 'From', value: 'Lead Person <lead@example.com>' },
          { name: 'To', value: 'sean@iconsofrealestate.com' },
          { name: 'Subject', value: 'Re: something' }
        ] }
      }]
    };
  };
  try {
    const found = gas.collectNewSeanHandoffThreads_();
    assert.equal(found.length, 1, 'the already-tracked thread must not be re-detected');
    assert.equal(found[0].threadId, 'thread-new');
  } finally {
    gas.getGmailAccessTokenForUser_ = originalGetToken;
    gas.gmailApiGet_ = originalGmailApiGet;
    gas.getOrCreateSeanFollowUpTrackerSheet_ = originalGetSheet;
  }
});

test('collectNewSeanHandoffThreads_ returns an empty array (never throws) when the handoff label does not exist yet in Joana\'s mailbox', () => {
  const originalGetToken = gas.getGmailAccessTokenForUser_;
  const originalGmailApiGet = gas.gmailApiGet_;
  const originalGetSheet = gas.getOrCreateSeanFollowUpTrackerSheet_;
  gas.getGmailAccessTokenForUser_ = () => 'fake-token';
  gas.getOrCreateSeanFollowUpTrackerSheet_ = () => ({ getLastRow: () => 1 });
  gas.gmailApiGet_ = (token, path) => {
    assert.equal(path, '/labels');
    return { labels: [{ id: 'Label_1', name: 'Dead' }] }; // no "SPAM - Sean" label
  };
  try {
    assert.deepEqual(Array.from(gas.collectNewSeanHandoffThreads_()), []);
  } finally {
    gas.getGmailAccessTokenForUser_ = originalGetToken;
    gas.gmailApiGet_ = originalGmailApiGet;
    gas.getOrCreateSeanFollowUpTrackerSheet_ = originalGetSheet;
  }
});

test('appendSeanHandoffTrackerRow_ writes Cadence=new_lead, Stage=handed_off, and the real anchor date', () => {
  const rows = [];
  const fakeSheet = { appendRow: (r) => rows.push(r) };
  const col = {};
  gas.SEAN_FOLLOWUP_TRACKER_HEADERS.forEach((h, i) => { col[h] = i; });
  const anchor = new Date(2026, 8, 7, 14, 30, 0);
  gas.appendSeanHandoffTrackerRow_(fakeSheet, { threadId: 'thread-new', leadEmail: 'lead@example.com', subject: 'Re: something', anchorDate: anchor });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row[col['Thread ID']], 'thread-new');
  assert.equal(row[col['Lead Email']], 'lead@example.com');
  assert.equal(row[col['Cadence']], 'new_lead');
  assert.equal(row[col['Stage']], 'handed_off');
  assert.equal(row[col['Anchor Date']], anchor);
});

test('buildAndMaybeRecordSeanHandoffs_ in dry-run logs but never writes to the tracker sheet', () => {
  const originalCollect = gas.collectNewSeanHandoffThreads_;
  const originalGetSheet = gas.getOrCreateSeanFollowUpTrackerSheet_;
  gas.collectNewSeanHandoffThreads_ = () => [{ threadId: 't1', leadEmail: 'lead@example.com', subject: 'x', anchorDate: new Date() }];
  gas.getOrCreateSeanFollowUpTrackerSheet_ = () => { throw new Error('must not touch the sheet in dry-run'); };
  try {
    const count = gas.buildAndMaybeRecordSeanHandoffs_(true);
    assert.equal(count, 1);
  } finally {
    gas.collectNewSeanHandoffThreads_ = originalCollect;
    gas.getOrCreateSeanFollowUpTrackerSheet_ = originalGetSheet;
  }
});

test('buildAndMaybeRecordSeanHandoffs_ live path appends one row per new handoff', () => {
  const originalCollect = gas.collectNewSeanHandoffThreads_;
  const originalGetSheet = gas.getOrCreateSeanFollowUpTrackerSheet_;
  const rows = [];
  gas.collectNewSeanHandoffThreads_ = () => [
    { threadId: 't1', leadEmail: 'a@example.com', subject: 'x', anchorDate: new Date() },
    { threadId: 't2', leadEmail: 'b@example.com', subject: 'y', anchorDate: new Date() }
  ];
  gas.getOrCreateSeanFollowUpTrackerSheet_ = () => ({ appendRow: (r) => rows.push(r) });
  try {
    const count = gas.buildAndMaybeRecordSeanHandoffs_(false);
    assert.equal(count, 2);
    assert.equal(rows.length, 2);
  } finally {
    gas.collectNewSeanHandoffThreads_ = originalCollect;
    gas.getOrCreateSeanFollowUpTrackerSheet_ = originalGetSheet;
  }
});

test('runSeanHandoffDetection is gated by DETECTION_ENABLED specifically, not the full pipeline ENABLED flag', () => {
  const originalConfig = gas.SEAN_FOLLOWUP_CONFIG;
  const originalCollect = gas.collectNewSeanHandoffThreads_;
  gas.collectNewSeanHandoffThreads_ = () => { throw new Error('must not run when DETECTION_ENABLED is false'); };
  gas.SEAN_FOLLOWUP_CONFIG = Object.assign({}, originalConfig, { ENABLED: true, DETECTION_ENABLED: false });
  try {
    const count = gas.runSeanHandoffDetection();
    assert.equal(count, 0);
  } finally {
    gas.SEAN_FOLLOWUP_CONFIG = originalConfig;
    gas.collectNewSeanHandoffThreads_ = originalCollect;
  }
});

// installSeanHandoffDetectionTrigger's own standalone-trigger test was
// replaced 07/09/2026 by the installPhase17To19StandingChecksTrigger tests
// further down (trigger-cap consolidation — Cadence 1 now shares one
// every-2-hour trigger with Cadence 2/Phase 18/Phase 19).

// ---------------------------------------------------------------------------
// Phase17 Cadence 2 — re-engagement, generalized to all reps. Kris's ask
// (07/09/2026): "build it with his guidelines but also Bens and Joana old
// leads, and Tomas too." Reads the Sales Call Log directly (already has the
// "which stage, when" signal the plan doc said was missing) instead of GHL.
// ---------------------------------------------------------------------------

function reengagementCol_(gas) {
  var col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach(function (h, i) { col[h] = i + 1; });
  return col;
}

function reengagementRow_(gas, { rep, name, email, callType, date, outcome }) {
  var col = reengagementCol_(gas);
  var row = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  row[col['Rep'] - 1] = rep;
  row[col['Prospect Name'] - 1] = name;
  row[col['Prospect Email'] - 1] = email || '';
  row[col['Call Type'] - 1] = callType;
  row[col['Call Date'] - 1] = date;
  row[col['Outcome Disposition'] - 1] = outcome || '';
  return row;
}

test('findLastRealCallPerLead_ picks the MOST RECENT eligible call per (rep, lead), across Bens/Joana/Sean/Tomás', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = reengagementCol_(gas);
  const rows = [
    reengagementRow_(gas, { rep: 'Bens', name: 'Lead A', email: 'a@example.com', callType: 'QC', date: bizDate(gas, 2026, 6, 1) }),
    reengagementRow_(gas, { rep: 'Bens', name: 'Lead A', email: 'a@example.com', callType: 'QC', date: bizDate(gas, 2026, 7, 1) }), // later QC, same lead -- supersedes
    reengagementRow_(gas, { rep: 'Joana', name: 'Lead B', email: 'b@example.com', callType: 'Sales Call', date: bizDate(gas, 2026, 6, 15) }),
    reengagementRow_(gas, { rep: 'Sean', name: 'Lead C', email: 'c@example.com', callType: 'Sales Call', date: bizDate(gas, 2026, 6, 20) }),
    reengagementRow_(gas, { rep: 'Tomás', name: 'Lead D', email: 'd@example.com', callType: 'Sales Call', date: bizDate(gas, 2026, 6, 25) }),
    reengagementRow_(gas, { rep: 'Other Rep', name: 'Not Tracked', email: 'x@example.com', callType: 'QC', date: bizDate(gas, 2026, 6, 1) })
  ];
  const lastCalls = gas.findLastRealCallPerLead_(rows, col);
  const byRep = {};
  lastCalls.forEach((c) => { byRep[c.rep] = c; });
  assert.equal(Object.keys(byRep).length, 4, 'only Bens/Joana/Sean/Tomás, not "Other Rep"');
  assert.equal(byRep['Bens'].callDate.getTime(), bizDate(gas, 2026, 7, 1).getTime(), 'the LATER of two QCs for the same lead must win');
  assert.ok(byRep['Joana']);
  assert.ok(byRep['Sean']);
  assert.ok(byRep['Tomás']);
});

test('findLastRealCallPerLead_ excludes a lead whose most recent call already resulted in Sold', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = reengagementCol_(gas);
  const rows = [
    reengagementRow_(gas, { rep: 'Sean', name: 'Closed Lead', email: 'closed@example.com', callType: 'Sales Call', date: bizDate(gas, 2026, 6, 1), outcome: 'Sold' }),
    reengagementRow_(gas, { rep: 'Sean', name: 'Open Lead', email: 'open@example.com', callType: 'Sales Call', date: bizDate(gas, 2026, 6, 1), outcome: 'Not Sold' })
  ];
  const lastCalls = gas.findLastRealCallPerLead_(rows, col);
  assert.equal(lastCalls.length, 1);
  assert.equal(lastCalls[0].prospectName, 'Open Lead');
});

test('findLastRealCallPerLead_ ignores Discovery calls -- not a Cadence 2 stage per the plan doc', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = reengagementCol_(gas);
  const rows = [reengagementRow_(gas, { rep: 'Sean', name: 'Lead A', callType: 'Discovery', date: bizDate(gas, 2026, 6, 1) })];
  assert.equal(gas.findLastRealCallPerLead_(rows, col).length, 0);
});

test('dueReengagementStepFor_ returns the LATEST due-and-unnotified step, not every overdue step at once', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const lastCall = { rep: 'Sean', leadKey: 'email:a@example.com', callDate: bizDate(gas, 2026, 1, 1) };
  const today = bizDate(gas, 2026, 8, 1); // ~7 months later -- 1wk/1mo/3mo/6mo all overdue, 12mo not yet
  const step = gas.dueReengagementStepFor_(lastCall, today, []);
  assert.equal(step.label, '6 months', 'must catch up on the latest overdue step, not backfill from the earliest');
});

test('dueReengagementStepFor_ returns null once the latest due step is already in notifiedKeys', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const lastCall = { rep: 'Sean', leadKey: 'email:a@example.com', callDate: bizDate(gas, 2026, 1, 1) };
  const today = bizDate(gas, 2026, 1, 10); // only "1 week" is due
  const notifiedKey = 'Sean|email:a@example.com|1 week';
  assert.equal(gas.dueReengagementStepFor_(lastCall, today, [notifiedKey]), null);
});

test('findDueReengagements_ combines last-call lookup and due-step check end to end', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = reengagementCol_(gas);
  const rows = [
    reengagementRow_(gas, { rep: 'Bens', name: 'Stalled Lead', email: 'stalled@example.com', callType: 'QC', date: bizDate(gas, 2026, 1, 1) }),
    reengagementRow_(gas, { rep: 'Sean', name: 'Fresh Lead', email: 'fresh@example.com', callType: 'Sales Call', date: bizDate(gas, 2026, 7, 30) })
  ];
  const today = bizDate(gas, 2026, 8, 1);
  const due = gas.findDueReengagements_(rows, col, today, []);
  assert.equal(due.length, 1, 'only the stalled lead is due; the fresh one has not hit even the 1-week mark');
  assert.equal(due[0].rep, 'Bens');
  assert.equal(due[0].prospectName, 'Stalled Lead');
});

test('findDueReengagements_ skips a lead whose override action is cancelled', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = reengagementCol_(gas);
  const rows = [
    reengagementRow_(gas, { rep: 'Bens', name: 'Stalled Lead', email: 'stalled@example.com', callType: 'QC', date: bizDate(gas, 2026, 1, 1) })
  ];
  const today = bizDate(gas, 2026, 8, 1);
  const overrides = { 'Bens|email:stalled@example.com': 'cancelled' };
  assert.equal(gas.findDueReengagements_(rows, col, today, [], overrides).length, 0);
});

test('findDueReengagements_ still includes a lead whose override action is deprioritized (display-only)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = reengagementCol_(gas);
  const rows = [
    reengagementRow_(gas, { rep: 'Bens', name: 'Stalled Lead', email: 'stalled@example.com', callType: 'QC', date: bizDate(gas, 2026, 1, 1) })
  ];
  const today = bizDate(gas, 2026, 8, 1);
  const overrides = { 'Bens|email:stalled@example.com': 'deprioritized' };
  assert.equal(gas.findDueReengagements_(rows, col, today, [], overrides).length, 1);
});

test('findDueReengagements_ defaults overrideActions to {} when omitted (back-compat)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = reengagementCol_(gas);
  const rows = [
    reengagementRow_(gas, { rep: 'Bens', name: 'Stalled Lead', email: 'stalled@example.com', callType: 'QC', date: bizDate(gas, 2026, 1, 1) })
  ];
  const today = bizDate(gas, 2026, 8, 1);
  assert.equal(gas.findDueReengagements_(rows, col, today, []).length, 1);
});

test('reengagementOverrideActionsFromRows_ keeps only the LAST action per rep+lead (append-only, last row wins)', () => {
  const rows = [
    ['Sean', 'a@example.com', 'Lead A', 'cancelled', 'kris@iconsofrealestate.com', new Date()],
    ['Sean', 'a@example.com', 'Lead A', 'active', 'kris@iconsofrealestate.com', new Date()],
    ['Joana', '', 'Lead B', 'deprioritized', 'joana@iconsofrealestate.com', new Date()]
  ];
  const actions = gas.reengagementOverrideActionsFromRows_(rows);
  assert.deepEqual(Object.assign({}, actions), {
    'Sean|email:a@example.com': 'active',
    'Joana|name:lead b': 'deprioritized'
  });
});

test('reengagementOverrideActionsFromRows_ skips blank rep or action', () => {
  const rows = [['', 'a@example.com', 'Lead A', 'cancelled', '', new Date()], ['Sean', 'b@example.com', 'Lead B', '', '', new Date()]];
  assert.deepEqual(Object.assign({}, gas.reengagementOverrideActionsFromRows_(rows)), {});
});

test('getReengagementOverrideActions_ returns {} when the sheet has no data rows yet', () => {
  assert.deepEqual(Object.assign({}, gas.getReengagementOverrideActions_({ getLastRow: () => 1 })), {});
});

test('getReengagementOverrideActions_ reads rows via getRange/getValues and reduces them the same way as reengagementOverrideActionsFromRows_', () => {
  const fakeSheet = {
    getLastRow: () => 2,
    getRange: () => ({ getValues: () => [['Sean', 'a@example.com', 'Lead A', 'cancelled', 'kris@iconsofrealestate.com', new Date()]] })
  };
  assert.deepEqual(Object.assign({}, gas.getReengagementOverrideActions_(fakeSheet)), { 'Sean|email:a@example.com': 'cancelled' });
});

test('getOrCreateReengagementOverridesSheet_ creates the tab with frozen header row if missing', () => {
  const created = {};
  const fakeNewSheet = {
    getRange: () => ({
      setValues: () => ({ setFontWeight: () => ({ setBackground: () => {} }) })
    }),
    setFrozenRows: (n) => { created.frozenRows = n; }
  };
  const fakeSs = {
    getSheetByName: () => null,
    insertSheet: (name) => { created.name = name; return fakeNewSheet; }
  };
  const originalSpreadsheetApp = gas.SpreadsheetApp;
  gas.SpreadsheetApp = { openById: () => fakeSs };
  try {
    const sheet = gas.getOrCreateReengagementOverridesSheet_();
    assert.equal(sheet, fakeNewSheet);
    assert.equal(created.name, 'Re-engagement Overrides');
    assert.equal(created.frozenRows, 1);
  } finally {
    gas.SpreadsheetApp = originalSpreadsheetApp;
  }
});

test('getNotifiedReengagementKeys_ reconstructs the leadKey from Lead Email/Lead Name and returns rep|leadKey|step strings', () => {
  const fakeSheet = {
    getLastRow: () => 2,
    getRange: () => ({
      getValues: () => [['Sean', 'Some Lead', 'lead@example.com', 'Sales Call', '01/07/2026', '1 week', '08/07/2026', new Date()]]
    })
  };
  const keys = gas.getNotifiedReengagementKeys_(fakeSheet);
  assert.deepEqual(Array.from(keys), ['Sean|email:lead@example.com|1 week']);
});

test('getNotifiedReengagementKeys_ returns empty array when the tracker has no data rows yet', () => {
  assert.deepEqual(Array.from(gas.getNotifiedReengagementKeys_({ getLastRow: () => 1 })), []);
});

test('appendReengagementTrackerRow_ writes rep/lead/call/step/due-date columns in order', () => {
  const rows = [];
  const fakeSheet = { appendRow: (r) => rows.push(r) };
  const originalUtilities = gas.Utilities;
  gas.Utilities = { formatDate: (d, tz, fmt) => 'FORMATTED' };
  try {
    gas.appendReengagementTrackerRow_(fakeSheet, {
      rep: 'Sean', prospectName: 'Some Lead', prospectEmail: 'lead@example.com',
      callType: 'Sales Call', callDate: new Date(), stepLabel: '1 week', dueAt: new Date()
    }, 'America/New_York');
    assert.equal(rows.length, 1);
    assert.deepEqual(Array.from(rows[0]).slice(0, 6), ['Sean', 'Some Lead', 'lead@example.com', 'Sales Call', 'FORMATTED', '1 week']);
  } finally {
    gas.Utilities = originalUtilities;
  }
});

test('buildReengagementDigestEmail_ groups due leads by rep', () => {
  gas.Utilities = { formatDate: () => '01/07/2026' };
  const dueItems = [
    { rep: 'Bens', prospectName: 'Lead A', prospectEmail: 'a@example.com', callType: 'QC', callDate: new Date(), stepLabel: '1 week' },
    { rep: 'Sean', prospectName: 'Lead B', prospectEmail: 'b@example.com', callType: 'Sales Call', callDate: new Date(), stepLabel: '1 month' }
  ];
  const email = gas.buildReengagementDigestEmail_(dueItems, 'America/New_York');
  assert.ok(email.subject.indexOf('2 lead(s)') !== -1);
  assert.ok(email.body.indexOf('Bens:') !== -1);
  assert.ok(email.body.indexOf('Sean:') !== -1);
  assert.ok(email.body.indexOf('Lead A') !== -1);
  assert.ok(email.htmlBody.indexOf('<strong>Bens</strong>') !== -1);
});

test('buildReengagementDigestEmail_ says plainly when nothing is due', () => {
  const email = gas.buildReengagementDigestEmail_([], 'America/New_York');
  assert.ok(email.body.indexOf('No leads due for re-engagement') !== -1);
  assert.ok(email.htmlBody.indexOf('No leads due for re-engagement') !== -1);
});

test('runReengagementDigest is gated by CADENCE2_ENABLED specifically', () => {
  const originalConfig = gas.SEAN_FOLLOWUP_CONFIG;
  const originalBuild = gas.buildAndMaybeSendReengagementDigest_;
  gas.buildAndMaybeSendReengagementDigest_ = () => { throw new Error('must not run when CADENCE2_ENABLED is false'); };
  gas.SEAN_FOLLOWUP_CONFIG = Object.assign({}, originalConfig, { CADENCE2_ENABLED: false });
  try {
    assert.equal(gas.runReengagementDigest(), 0);
  } finally {
    gas.SEAN_FOLLOWUP_CONFIG = originalConfig;
    gas.buildAndMaybeSendReengagementDigest_ = originalBuild;
  }
});

// installReengagementDigestTrigger's own standalone-trigger test was
// replaced 07/09/2026 by the installPhase17To19StandingChecksTrigger tests
// further down (trigger-cap consolidation). The STANDING_AUTOMATION_HANDLERS_
// coverage for Cadence 2 is folded into the consolidated-handler test above.

// ---------------------------------------------------------------------------
// Phase18_PitchGuideReview.gs — Kris's ask (07/09/2026), confirming the
// recurring monthly cycle: "YES we are about to do the first pitch guide
// training today. I will send you the recording so you can suggest updates
// to the SOP. Then moving forward once per month, you send suggestions to
// the SOP based on all the sales calls. Tomas will approve or not." Same
// Drive-folder-driven, video-in/transcript-appears/judge-it shape as
// Phase16_CalibrationFeedback.gs, but comparing a training transcript
// against the live Pitch Guide doc instead of grading one sales call.
// ---------------------------------------------------------------------------

test('collectPitchGuideTrainingVideos_ returns only video/* files from the training folder, ignoring transcript/marker Docs already sitting there', () => {
  const folder = fakeCalibrationFolder_([
    { name: 'Pitch Guide 1.mp4', mimeType: 'video/mp4' },
    { name: 'Pitch Guide 1.mp4 — Transcript', mimeType: 'application/vnd.google-apps.document' },
    { name: 'Pitch Guide 1.mp4 — Reviewed', mimeType: 'application/vnd.google-apps.document' }
  ]);
  const videos = Array.prototype.slice.call(gas.collectPitchGuideTrainingVideos_(folder)).map((f) => f.getName());
  assert.deepEqual(videos, ['Pitch Guide 1.mp4']);
});

test('findPitchGuideTranscript_ finds the exact "<video name> — Transcript" sibling', () => {
  const folder = fakeCalibrationFolder_([
    { name: 'Pitch Guide 1.mp4 — Transcript', mimeType: 'application/vnd.google-apps.document' }
  ]);
  const video = fakeCalibrationVideoFile_('Pitch Guide 1.mp4');
  assert.ok(gas.findPitchGuideTranscript_(folder, video));
});

test('findPitchGuideTranscript_ returns null when no transcript exists yet — the driver must wait for tools/transcribe_pitch_guide_training.py, not fail', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Pitch Guide 1.mp4');
  assert.equal(gas.findPitchGuideTranscript_(folder, video), null);
});

test('pitchGuideTrainingAlreadyReviewed_ is true only once the "— Reviewed" marker exists', () => {
  const reviewedFolder = fakeCalibrationFolder_([{ name: 'Pitch Guide 1.mp4 — Reviewed', mimeType: 'application/vnd.google-apps.document' }]);
  const freshFolder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Pitch Guide 1.mp4');
  assert.equal(gas.pitchGuideTrainingAlreadyReviewed_(reviewedFolder, video), true);
  assert.equal(gas.pitchGuideTrainingAlreadyReviewed_(freshFolder, video), false);
});

test('isValidPitchGuideReviewSchema_ accepts a well-formed suggestions/outdatedFlags object and rejects a malformed one', () => {
  assert.equal(gas.isValidPitchGuideReviewSchema_({
    suggestions: [{ gap: 'x', quote: 'y', suggestedEdit: 'z', confidence: 'High' }],
    outdatedFlags: [{ quote: 'the deck needs a revolution' }]
  }), true);
  assert.equal(gas.isValidPitchGuideReviewSchema_({ suggestions: [{ gap: 'x' }], outdatedFlags: [] }), false, 'missing quote/suggestedEdit/confidence');
  assert.equal(gas.isValidPitchGuideReviewSchema_({ suggestions: [{ gap: 'x', quote: 'y', suggestedEdit: 'z', confidence: 'Extreme' }], outdatedFlags: [] }), false, 'confidence must be High/Medium/Low');
  assert.equal(gas.isValidPitchGuideReviewSchema_(null), false);
});

test('gradePitchGuideTraining_ retries once with a "raw JSON only" reminder on a parse failure, and succeeds if the retry parses', () => {
  const originalConfig = gas.PHASE2_CONFIG;
  const originalCallKimiJudge = gas.callKimiJudge_;
  const promptsSeen = [];
  try {
    gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 1 };
    let call = 0;
    gas.callKimiJudge_ = (systemPrompt, userPrompt) => {
      promptsSeen.push(userPrompt);
      call++;
      if (call === 1) return 'not json';
      return JSON.stringify({ suggestions: [{ gap: 'g', quote: 'q', suggestedEdit: 'e', confidence: 'High' }], outdatedFlags: [] });
    };
    const result = gas.gradePitchGuideTraining_('Pitch Guide 1.mp4', 'transcript text', 'pitch guide doc text');
    assert.equal(result.suggestions.length, 1);
    assert.equal(promptsSeen.length, 2);
    assert.ok(promptsSeen[1].indexOf('raw JSON') !== -1, 'the retry prompt must include the "raw JSON only" reminder');
  } finally {
    gas.PHASE2_CONFIG = originalConfig;
    gas.callKimiJudge_ = originalCallKimiJudge;
  }
});

test('gradePitchGuideTraining_ falls back to empty suggestions/outdatedFlags (never throws) when every attempt fails — one bad model response must not stop the whole monthly run', () => {
  const originalConfig = gas.PHASE2_CONFIG;
  const originalCallKimiJudge = gas.callKimiJudge_;
  try {
    gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 1 };
    gas.callKimiJudge_ = () => { throw new Error('LlmTransportError_: boom'); };
    const result = gas.gradePitchGuideTraining_('Pitch Guide 1.mp4', 'transcript text', 'pitch guide doc text');
    assert.equal(result.suggestions.length, 0);
    assert.equal(result.outdatedFlags.length, 0);
  } finally {
    gas.PHASE2_CONFIG = originalConfig;
    gas.callKimiJudge_ = originalCallKimiJudge;
  }
});

test('appendPitchGuideSuggestionRows_ writes one row per suggestion, numbered in order, with a blank Tomás Verdict and Applied=false', () => {
  const rows = [];
  const fakeSheet = { appendRow: (r) => rows.push(r) };
  const graded = {
    suggestions: [
      { gap: 'no pre-call sequence', quote: 'we have those emails', suggestedEdit: 'add a pre-call section', confidence: 'High' },
      { gap: 'no VA question', quote: 'I always ask about a VA', suggestedEdit: 'add VA question', confidence: 'Medium' }
    ]
  };
  gas.appendPitchGuideSuggestionRows_(fakeSheet, 'Pitch Guide 1.mp4', '07/09/2026', graded);
  assert.equal(rows.length, 2);
  // Compared field-by-field, not via deepEqual — the row arrays are built inside the vm
  // sandbox's own realm (see gas_env.js's Date comment for the same reasoning), so a
  // realm/constructor-identity check against these plain outer-literal arrays would fail
  // even though the contents match exactly.
  assert.equal(Array.prototype.join.call(rows[0], '|'), ['Pitch Guide 1.mp4', '07/09/2026', 1, 'no pre-call sequence', 'we have those emails', 'add a pre-call section', 'High', '', false].join('|'));
  assert.equal(Array.prototype.join.call(rows[1], '|'), ['Pitch Guide 1.mp4', '07/09/2026', 2, 'no VA question', 'I always ask about a VA', 'add VA question', 'Medium', '', false].join('|'));
});

test('buildPitchGuideReviewEmail_ links the recording and the tracking sheet, and lists any explicitly-flagged outdated quotes', () => {
  const graded = {
    suggestions: [{ gap: 'g', quote: 'q', suggestedEdit: 'e', confidence: 'High' }],
    outdatedFlags: [{ quote: 'this needs a revolution' }]
  };
  const email = gas.buildPitchGuideReviewEmail_('Pitch Guide 1.mp4', 'https://drive.google.com/x', 'https://docs.google.com/spreadsheets/d/sheet', graded);
  assert.ok(email.subject.indexOf('1 suggestion') !== -1);
  assert.ok(email.body.indexOf('https://drive.google.com/x') !== -1);
  assert.ok(email.body.indexOf('https://docs.google.com/spreadsheets/d/sheet') !== -1);
  assert.ok(email.body.indexOf('this needs a revolution') !== -1);
  assert.ok(email.htmlBody.indexOf('<a href="https://drive.google.com/x">') !== -1);
  assert.ok(email.htmlBody.indexOf('this needs a revolution') !== -1);
});

test('buildPitchGuideReviewEmail_ omits the outdated-flags section entirely when nothing was flagged', () => {
  const graded = { suggestions: [], outdatedFlags: [] };
  const email = gas.buildPitchGuideReviewEmail_('Pitch Guide 1.mp4', 'https://drive.google.com/x', 'https://docs.google.com/spreadsheets/d/sheet', graded);
  assert.ok(email.body.indexOf('explicitly flagged') === -1);
  assert.ok(email.htmlBody.indexOf('explicitly flagged') === -1);
});

test('processPitchGuideTrainingVideo_ writes suggestion rows, emails Tomás (cc Kris), and drops a "Reviewed" marker only after a successful send', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Pitch Guide 1.mp4', { url: 'https://drive.google.com/file/d/xyz' });
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };

  const originalGetTranscriptText = gas.getTranscriptText_;
  const originalGrade = gas.gradePitchGuideTraining_;
  const originalGetSheet = gas.getOrCreatePitchGuideSuggestionsSheet_;
  const originalGuardedSend = gas.guardedSend_;
  const originalDocumentApp = gas.DocumentApp;
  const originalDriveApp = gas.DriveApp;
  const originalUtilities = gas.Utilities;
  const originalConfig = gas.CONFIG;

  let sendArgs = null;
  const writtenRows = [];
  const movedMarkers = [];
  gas.getTranscriptText_ = () => 'training transcript text';
  gas.gradePitchGuideTraining_ = () => ({ suggestions: [{ gap: 'g', quote: 'q', suggestedEdit: 'e', confidence: 'High' }], outdatedFlags: [] });
  gas.getOrCreatePitchGuideSuggestionsSheet_ = () => ({
    appendRow: (r) => writtenRows.push(r),
    getSheetId: () => 42
  });
  gas.guardedSend_ = (...args) => { sendArgs = args; return true; };
  const fakeMarkerDoc = { getBody: () => ({ setText: () => {} }), saveAndClose: () => {}, getId: () => 'marker-id' };
  gas.DocumentApp = { create: () => fakeMarkerDoc };
  gas.DriveApp = { getFileById: (id) => ({ moveTo: (f) => movedMarkers.push({ id, folder: f }) }) };
  gas.Utilities = { formatDate: () => '07/09/2026' };
  gas.CONFIG = Object.assign({}, originalConfig, { TOMAS_EMAIL: 'tomas@iconsofrealestate.com', KRIS_EMAIL: 'kris@iconsofrealestate.com' });

  try {
    const didWork = gas.processPitchGuideTrainingVideo_(folder, video, transcriptFile, 'pitch guide doc text', false);
    assert.equal(didWork, true);
    assert.equal(writtenRows.length, 1);
    assert.equal(sendArgs[0], 'tomas@iconsofrealestate.com', 'must send to Tomás');
    assert.equal(sendArgs[3].cc, 'kris@iconsofrealestate.com');
    assert.equal(movedMarkers.length, 1, 'the Reviewed marker must be moved into the training folder');
    assert.equal(movedMarkers[0].folder, folder);
  } finally {
    gas.getTranscriptText_ = originalGetTranscriptText;
    gas.gradePitchGuideTraining_ = originalGrade;
    gas.getOrCreatePitchGuideSuggestionsSheet_ = originalGetSheet;
    gas.guardedSend_ = originalGuardedSend;
    gas.DocumentApp = originalDocumentApp;
    gas.DriveApp = originalDriveApp;
    gas.Utilities = originalUtilities;
    gas.CONFIG = originalConfig;
  }
});

test('processPitchGuideTrainingVideo_ still writes the suggestion rows even when the send fails, but does not drop a "Reviewed" marker — so a retry does not lose the analysis but does re-attempt notifying Tomás', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Pitch Guide 1.mp4');
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };
  const originalGetTranscriptText = gas.getTranscriptText_;
  const originalGrade = gas.gradePitchGuideTraining_;
  const originalGetSheet = gas.getOrCreatePitchGuideSuggestionsSheet_;
  const originalGuardedSend = gas.guardedSend_;
  const originalDocumentApp = gas.DocumentApp;
  const originalUtilities = gas.Utilities;
  const writtenRows = [];
  gas.getTranscriptText_ = () => FAKE_TRANSCRIPT_;
  gas.gradePitchGuideTraining_ = () => ({ suggestions: [{ gap: 'g', quote: 'q', suggestedEdit: 'e', confidence: 'High' }], outdatedFlags: [] });
  gas.getOrCreatePitchGuideSuggestionsSheet_ = () => ({ appendRow: (r) => writtenRows.push(r), getSheetId: () => 1 });
  gas.guardedSend_ = () => false;
  gas.DocumentApp = { create: () => { throw new Error('must not create a Reviewed marker — send failed'); } };
  gas.Utilities = { formatDate: () => '07/09/2026' };
  try {
    const didWork = gas.processPitchGuideTrainingVideo_(folder, video, transcriptFile, 'pitch guide doc text', false);
    assert.equal(didWork, false);
    assert.equal(writtenRows.length, 1, 'suggestions already computed must still be persisted even though the email failed');
  } finally {
    gas.getTranscriptText_ = originalGetTranscriptText;
    gas.gradePitchGuideTraining_ = originalGrade;
    gas.getOrCreatePitchGuideSuggestionsSheet_ = originalGetSheet;
    gas.guardedSend_ = originalGuardedSend;
    gas.DocumentApp = originalDocumentApp;
    gas.Utilities = originalUtilities;
  }
});

test('processPitchGuideTrainingVideo_ in dry-run logs but never writes rows, sends, or creates a marker', () => {
  const folder = fakeCalibrationFolder_([]);
  const video = fakeCalibrationVideoFile_('Pitch Guide 1.mp4');
  const transcriptFile = { getMimeType: () => 'application/vnd.google-apps.document', getId: () => 'transcript-doc-id' };
  const originalGetTranscriptText = gas.getTranscriptText_;
  const originalGrade = gas.gradePitchGuideTraining_;
  const originalGetSheet = gas.getOrCreatePitchGuideSuggestionsSheet_;
  const originalGuardedSend = gas.guardedSend_;
  gas.getTranscriptText_ = () => FAKE_TRANSCRIPT_;
  gas.gradePitchGuideTraining_ = () => ({ suggestions: [{ gap: 'g', quote: 'q', suggestedEdit: 'e', confidence: 'High' }], outdatedFlags: [] });
  gas.getOrCreatePitchGuideSuggestionsSheet_ = () => { throw new Error('must not touch the sheet in dry-run'); };
  gas.guardedSend_ = () => { throw new Error('must not send in dry-run'); };
  try {
    const didWork = gas.processPitchGuideTrainingVideo_(folder, video, transcriptFile, 'pitch guide doc text', true);
    assert.equal(didWork, false);
  } finally {
    gas.getTranscriptText_ = originalGetTranscriptText;
    gas.gradePitchGuideTraining_ = originalGrade;
    gas.getOrCreatePitchGuideSuggestionsSheet_ = originalGetSheet;
    gas.guardedSend_ = originalGuardedSend;
  }
});

test('buildAndMaybeSendPitchGuideReview_ skips an already-reviewed video and one with no transcript yet, only processing the one genuinely pending video', () => {
  const folder = fakeCalibrationFolder_([
    { name: 'Old Training.mp4', mimeType: 'video/mp4' },
    { name: 'Old Training.mp4 — Transcript', mimeType: 'application/vnd.google-apps.document' },
    { name: 'Old Training.mp4 — Reviewed', mimeType: 'application/vnd.google-apps.document' },
    { name: 'No Transcript Yet.mp4', mimeType: 'video/mp4' },
    { name: 'Pitch Guide 1.mp4', mimeType: 'video/mp4' },
    { name: 'Pitch Guide 1.mp4 — Transcript', mimeType: 'application/vnd.google-apps.document' }
  ]);
  const originalDriveApp = gas.DriveApp;
  const originalFetch = gas.fetchPitchGuideDocText_;
  const originalProcess = gas.processPitchGuideTrainingVideo_;
  const processed = [];
  gas.DriveApp = { getFolderById: () => folder };
  gas.fetchPitchGuideDocText_ = () => 'pitch guide doc text';
  gas.processPitchGuideTrainingVideo_ = (folderArg, videoFile) => { processed.push(videoFile.getName()); return true; };
  try {
    const count = gas.buildAndMaybeSendPitchGuideReview_(false);
    assert.deepEqual(processed, ['Pitch Guide 1.mp4']);
    assert.equal(count, 1);
  } finally {
    gas.DriveApp = originalDriveApp;
    gas.fetchPitchGuideDocText_ = originalFetch;
    gas.processPitchGuideTrainingVideo_ = originalProcess;
  }
});

test('fetchPitchGuideDocText_ throws a clear "share the doc" error rather than a bare permission exception when the live Apps Script account cannot open the Pitch Guide doc', () => {
  const originalDocumentApp = gas.DocumentApp;
  gas.DocumentApp = { openById: () => { throw new Error('You do not have permission'); } };
  try {
    assert.throws(() => gas.fetchPitchGuideDocText_(), /share it with whichever account|Make sure it is shared/);
  } finally {
    gas.DocumentApp = originalDocumentApp;
  }
});

// installPitchGuideReviewTrigger's own standalone-trigger test was replaced
// 07/09/2026 by the installPhase17To19StandingChecksTrigger tests further
// down (trigger-cap consolidation).

// ---------------------------------------------------------------------------
// Phase19_SeanEscalationReport.gs — Kris's confirmed ask (07/09/2026): "YES
// a report to Tomas and I is useful" — which of Sean's Sales Calls should
// have escalated to a Second Sales Call with Tomás instead of an AM
// Discovery call. Reuses the existing "Flag: Booking Decision Appropriate"/
// "Booking Decision Gap" scored dimension (Phase2_CallScoring.gs).
// ---------------------------------------------------------------------------

function seanEscalationCol_(gas) {
  var col = {};
  gas.SALES_CALL_LOG_HEADERS.forEach(function (h, i) { col[h] = i + 1; });
  return col;
}

function seanEscalationRow_(gas, { rep, name, date, score, bookingAppropriate, gap, transcriptUrl }) {
  var col = seanEscalationCol_(gas);
  var row = new Array(gas.SALES_CALL_LOG_HEADERS.length).fill('');
  row[col['Rep'] - 1] = rep;
  row[col['Prospect Name'] - 1] = name;
  row[col['Call Date'] - 1] = date;
  row[col['Call Quality Score'] - 1] = score;
  row[col['Flag: Booking Decision Appropriate'] - 1] = bookingAppropriate;
  row[col['Booking Decision Gap'] - 1] = gap || '';
  row[col['Transcript URL'] - 1] = transcriptUrl || '';
  return row;
}

test('findSeanEscalationMisses_ flags only Sean\'s calls this week with Booking Decision Appropriate explicitly false', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = seanEscalationCol_(gas);
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const fakeSheet = { getSheetId: () => 42 };
  const rows = [
    seanEscalationRow_(gas, { rep: 'Sean', name: 'Miss A', date: bizDate(gas, 2026, 8, 11), score: 2, bookingAppropriate: false, gap: 'Should have gone to Tomás' }),
    seanEscalationRow_(gas, { rep: 'Sean', name: 'Fine B', date: bizDate(gas, 2026, 8, 12), score: 4, bookingAppropriate: true }),
    seanEscalationRow_(gas, { rep: 'Sean', name: 'Not Scored C', date: bizDate(gas, 2026, 8, 12), score: 3, bookingAppropriate: '' }), // blank = no signal, never a miss
    seanEscalationRow_(gas, { rep: 'Joana', name: 'Different Rep', date: bizDate(gas, 2026, 8, 11), score: 1, bookingAppropriate: false }),
    seanEscalationRow_(gas, { rep: 'Sean', name: 'Before Week', date: bizDate(gas, 2026, 8, 3), score: 1, bookingAppropriate: false })
  ];
  const misses = gas.findSeanEscalationMisses_(rows, col, fakeSheet, weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].prospectName, 'Miss A');
  assert.equal(misses[0].gap, 'Should have gone to Tomás');
});

test('findSeanEscalationMisses_ treats a text "FALSE"/"No" cell the same as a real boolean false (hand-corrected cells)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = seanEscalationCol_(gas);
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const fakeSheet = { getSheetId: () => 1 };
  const rows = [
    seanEscalationRow_(gas, { rep: 'Sean', name: 'Text False', date: bizDate(gas, 2026, 8, 11), score: 2, bookingAppropriate: 'FALSE' }),
    seanEscalationRow_(gas, { rep: 'Sean', name: 'Text No', date: bizDate(gas, 2026, 8, 12), score: 2, bookingAppropriate: 'No' })
  ];
  const misses = gas.findSeanEscalationMisses_(rows, col, fakeSheet, weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(misses.length, 2);
});

test('findSeanEscalationMisses_ returns rowLink pointing at the real sheet row (accounting for the header)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const col = seanEscalationCol_(gas);
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const fakeSheet = { getSheetId: () => 99 };
  const rows = [
    seanEscalationRow_(gas, { rep: 'Other', name: 'Filler', date: bizDate(gas, 2026, 8, 11), score: 3, bookingAppropriate: '' }),
    seanEscalationRow_(gas, { rep: 'Sean', name: 'Miss A', date: bizDate(gas, 2026, 8, 11), score: 2, bookingAppropriate: false })
  ];
  const misses = gas.findSeanEscalationMisses_(rows, col, fakeSheet, weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(misses.length, 1);
  assert.ok(misses[0].rowLink.indexOf('range=A3') !== -1, 'row 2 of data (index 1) is real sheet row 3');
});

test('buildSeanEscalationReportEmail_ lists every miss with score/gap/links when there are some', () => {
  const misses = [
    { prospectName: 'Miss A', callDate: '11/08/2026', score: 2, gap: 'Should have gone to Tomás', transcriptUrl: 'https://drive.google.com/x', rowLink: 'https://sheet/row3' }
  ];
  const email = gas.buildSeanEscalationReportEmail_(misses, '10/08/2026 - 16/08/2026');
  assert.ok(email.subject.indexOf('1 booking-decision miss') !== -1);
  assert.ok(email.body.indexOf('Miss A') !== -1);
  assert.ok(email.body.indexOf('Should have gone to Tomás') !== -1);
  assert.ok(email.body.indexOf('https://drive.google.com/x') !== -1);
  assert.ok(email.htmlBody.indexOf('Miss A') !== -1);
  assert.ok(email.htmlBody.indexOf('Second Sales Call with Tomás') !== -1);
});

test('buildSeanEscalationReportEmail_ says plainly when there are no misses this week, rather than an empty list', () => {
  const email = gas.buildSeanEscalationReportEmail_([], '10/08/2026 - 16/08/2026');
  assert.ok(email.body.indexOf('No booking-decision misses for Sean this week') !== -1);
  assert.ok(email.htmlBody.indexOf('No booking-decision misses for Sean this week') !== -1);
});

test('sendSeanEscalationReportEmail_ sends to Tomás, cc Kris', () => {
  const originalGuardedSend = gas.guardedSend_;
  let sendArgs = null;
  gas.guardedSend_ = (...args) => { sendArgs = args; return true; };
  try {
    const sent = gas.sendSeanEscalationReportEmail_([], '10/08/2026 - 16/08/2026');
    assert.equal(sent, true);
    assert.equal(sendArgs[0], gas.CONFIG.TOMAS_EMAIL);
    assert.equal(sendArgs[3].cc, gas.CONFIG.KRIS_EMAIL);
  } finally {
    gas.guardedSend_ = originalGuardedSend;
  }
});

// installSeanEscalationReportTrigger's own standalone-trigger test was
// replaced 07/09/2026 by the installPhase17To19StandingChecksTrigger tests
// below (trigger-cap consolidation).

// ---------------------------------------------------------------------------
// Trigger-cap consolidation (07/09/2026) — Phase 17 (both cadences)/18/19
// share ONE every-2-hour trigger (runPhase17To19StandingChecks_) instead of
// 4 separate ones, after Kris hit Apps Script's 20-trigger project cap with
// only 1 slot free and 4 pending automations of different cadences.
// ---------------------------------------------------------------------------

test('isWithinHourWindow_ is true only within [targetHour, targetHour+windowHours)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = 'America/New_York';
  assert.equal(gas.isWithinHourWindow_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, 9, 0, 0), tz, 9, 2), true);
  assert.equal(gas.isWithinHourWindow_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, 10, 59, 0), tz, 9, 2), true);
  assert.equal(gas.isWithinHourWindow_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, 11, 0, 0), tz, 9, 2), false);
  assert.equal(gas.isWithinHourWindow_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, 8, 59, 0), tz, 9, 2), false);
});

test('duePhase17To19Passes_ always includes runSeanHandoffDetection regardless of day/hour', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const names = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, 3, 0, 0), 'America/New_York').map((p) => p.name);
  assert.ok(names.indexOf('runSeanHandoffDetection') !== -1);
});

test('duePhase17To19Passes_ includes runReengagementDigest only within its own trigger-hour window, any day', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = 'America/New_York';
  const inWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, gas.SEAN_FOLLOWUP_CONFIG.CADENCE2_TRIGGER_HOUR, 0, 0), tz)
    .map((p) => p.name);
  const outOfWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, gas.SEAN_FOLLOWUP_CONFIG.CADENCE2_TRIGGER_HOUR + 5, 0, 0), tz)
    .map((p) => p.name);
  assert.ok(inWindow.indexOf('runReengagementDigest') !== -1);
  assert.ok(outOfWindow.indexOf('runReengagementDigest') === -1);
});

test('duePhase17To19Passes_ includes runSeanEscalationReport only on Friday within its own trigger-hour window', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = 'America/New_York';
  // 02/01/2026 is a Friday.
  const fridayInWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 2, gas.SEAN_ESCALATION_REPORT_CONFIG.TRIGGER_HOUR, 0, 0), tz)
    .map((p) => p.name);
  const fridayOutOfWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 2, gas.SEAN_ESCALATION_REPORT_CONFIG.TRIGGER_HOUR + 5, 0, 0), tz)
    .map((p) => p.name);
  const saturdayInWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 3, gas.SEAN_ESCALATION_REPORT_CONFIG.TRIGGER_HOUR, 0, 0), tz)
    .map((p) => p.name);
  assert.ok(fridayInWindow.indexOf('runSeanEscalationReport') !== -1);
  assert.ok(fridayOutOfWindow.indexOf('runSeanEscalationReport') === -1);
  assert.ok(saturdayInWindow.indexOf('runSeanEscalationReport') === -1, 'must not fire on a non-Friday even within the right hour window');
});

test('duePhase17To19Passes_ includes runPitchGuideReview only on TRIGGER_DAY_OF_MONTH within its own trigger-hour window', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = 'America/New_York';
  const day = gas.PITCH_GUIDE_REVIEW_CONFIG.TRIGGER_DAY_OF_MONTH;
  const hour = gas.PITCH_GUIDE_REVIEW_CONFIG.TRIGGER_HOUR;
  const onDayInWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 2, day, hour, 0, 0), tz).map((p) => p.name);
  const onDayOutOfWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 2, day, hour + 5, 0, 0), tz).map((p) => p.name);
  const wrongDayInWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 2, day + 1, hour, 0, 0), tz).map((p) => p.name);
  assert.ok(onDayInWindow.indexOf('runPitchGuideReview') !== -1);
  assert.ok(onDayOutOfWindow.indexOf('runPitchGuideReview') === -1);
  assert.ok(wrongDayInWindow.indexOf('runPitchGuideReview') === -1);
});

test('runPhase17To19StandingChecks_ calls only the due passes and isolates one pass throwing from the others', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const originalDue = gas.duePhase17To19Passes_;
  const originalAlert = gas.sendOpsAlert_;
  const calls = [];
  const alerts = [];
  gas.sendOpsAlert_ = (subject, body) => alerts.push(subject);
  gas.duePhase17To19Passes_ = () => ([
    { name: 'passA', fn: () => calls.push('passA') },
    { name: 'passB', fn: () => { throw new Error('boom'); } },
    { name: 'passC', fn: () => calls.push('passC') }
  ]);
  try {
    gas.runPhase17To19StandingChecks_();
    assert.deepEqual(calls, ['passA', 'passC']);
    assert.deepEqual(alerts, ['Standing check error: passB']);
  } finally {
    gas.duePhase17To19Passes_ = originalDue;
    gas.sendOpsAlert_ = originalAlert;
  }
});

test('installPhase17To19StandingChecksTrigger removes any existing runPhase17To19StandingChecks_ trigger before creating the new every-2-hours one', () => {
  const deleted = [];
  let createdConfig = null;
  const fakeTriggerBuilder = {
    timeBased: () => fakeTriggerBuilder,
    everyHours: (h) => { createdConfig = { everyHours: h }; return fakeTriggerBuilder; },
    create: () => { createdConfig.created = true; }
  };
  const oldTrigger = { getHandlerFunction: () => 'runPhase17To19StandingChecks_' };
  const unrelatedTrigger = { getHandlerFunction: () => 'someOtherTrigger' };
  const originalScriptApp = gas.ScriptApp;
  gas.ScriptApp = {
    getProjectTriggers: () => [oldTrigger, unrelatedTrigger],
    deleteTrigger: (t) => deleted.push(t),
    newTrigger: () => fakeTriggerBuilder
  };
  try {
    gas.installPhase17To19StandingChecksTrigger();
    assert.deepEqual(deleted, [oldTrigger]);
    assert.equal(createdConfig.everyHours, 2);
    assert.equal(createdConfig.created, true);
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

// ---------------------------------------------------------------------------
// Phase 20 — Bens lead status report
// ---------------------------------------------------------------------------

test('findBensLeadSalesCallStatuses_ matches a tracker lead to their most recent Sales Call by email, any rep', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [
    bensTrackerRow(gas, { Name: 'Joey Lamielle', Email: 'joey@example.com' })
  ];
  const lCol = bensLogCol(gas);
  const logRows = [
    fakeSalesCallLogRow({
      'Prospect Email': 'joey@example.com', 'Call Type': 'Sales Call', Rep: 'Tomás',
      'Call Date': new gas.Date(2026, 7, 1), 'Outcome Logged': true, 'Outcome Disposition': 'Follow-up'
    }),
    fakeSalesCallLogRow({
      'Prospect Email': 'joey@example.com', 'Call Type': 'Sales Call', Rep: 'Tomás',
      'Call Date': new gas.Date(2026, 8, 5), 'Outcome Logged': true, 'Outcome Disposition': 'Sold'
    })
  ];
  const result = gas.findBensLeadSalesCallStatuses_(trackerRows, tCol, logRows, lCol);
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].outcomeDisposition, 'Sold', 'must pick the MOST RECENT Sales Call, not the first match');
  assert.equal(result.statuses[0].showedUp, true);
  assert.equal(result.stats.matched, 1);
});

test('findBensLeadSalesCallStatuses_ ignores Discovery/QC/Icons 100 Recording rows -- only a real Sales Call counts', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [bensTrackerRow(gas, { Name: 'Andrea Brunson', Email: 'andrea@example.com' })];
  const lCol = bensLogCol(gas);
  const logRows = [
    fakeSalesCallLogRow({ 'Prospect Email': 'andrea@example.com', 'Call Type': 'QC', Rep: 'Bens', 'Call Date': new gas.Date(2026, 7, 1) }),
    fakeSalesCallLogRow({ 'Prospect Email': 'andrea@example.com', 'Call Type': 'Discovery', Rep: 'Joana', 'Call Date': new gas.Date(2026, 7, 2) }),
    fakeSalesCallLogRow({ 'Prospect Email': 'andrea@example.com', 'Call Type': 'Icons 100 Recording', Rep: 'Bens', 'Call Date': new gas.Date(2026, 7, 3) })
  ];
  const result = gas.findBensLeadSalesCallStatuses_(trackerRows, tCol, logRows, lCol);
  assert.equal(result.statuses.length, 0);
  assert.equal(result.stats.noSalesCallYet, 1);
});

test('findBensLeadSalesCallStatuses_ marks No-show as not showed up, and blank disposition with Outcome Logged as "no disposition set yet"', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [
    bensTrackerRow(gas, { Name: 'A', Email: 'a@example.com' }),
    bensTrackerRow(gas, { Name: 'B', Email: 'b@example.com' })
  ];
  const lCol = bensLogCol(gas);
  const logRows = [
    fakeSalesCallLogRow({ 'Prospect Email': 'a@example.com', 'Call Type': 'Sales Call', Rep: 'Sean', 'Call Date': new gas.Date(2026, 7, 1), 'Outcome Disposition': 'No-show' }),
    fakeSalesCallLogRow({ 'Prospect Email': 'b@example.com', 'Call Type': 'Sales Call', Rep: 'Sean', 'Call Date': new gas.Date(2026, 7, 1), 'Outcome Logged': true, 'Outcome Disposition': '' })
  ];
  const result = gas.findBensLeadSalesCallStatuses_(trackerRows, tCol, logRows, lCol);
  const byEmail = {}; result.statuses.forEach((s) => { byEmail[s.email] = s; });
  assert.equal(byEmail['a@example.com'].showedUp, false);
  assert.equal(byEmail['b@example.com'].outcomeDisposition, '(logged, no disposition set yet)');
});

test('findBensLeadSalesCallStatuses_ counts a tracker row with no email as noEmail, never as noSalesCallYet', () => {
  const tCol = bensTrackerCol(gas);
  const trackerRows = [bensTrackerRow(gas, { Name: 'No Email Guy', Email: '' })];
  const lCol = bensLogCol(gas);
  const result = gas.findBensLeadSalesCallStatuses_(trackerRows, tCol, [], lCol);
  assert.equal(result.statuses.length, 0);
  assert.equal(result.stats.noEmail, 1);
  assert.equal(result.stats.noSalesCallYet, 0);
});

test('duePhase17To19Passes_ includes runBensLeadStatusReport only on Friday within its own trigger-hour window', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = 'America/New_York';
  const hour = gas.BENS_LEAD_STATUS_REPORT_CONFIG.TRIGGER_HOUR;
  // 02/01/2026 is a Friday.
  const fridayInWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 2, hour, 0, 0), tz).map((p) => p.name);
  const fridayOutOfWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 2, hour + 5, 0, 0), tz).map((p) => p.name);
  const saturdayInWindow = gas.duePhase17To19Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 3, hour, 0, 0), tz).map((p) => p.name);
  assert.ok(fridayInWindow.indexOf('runBensLeadStatusReport') !== -1);
  assert.ok(fridayOutOfWindow.indexOf('runBensLeadStatusReport') === -1);
  assert.ok(saturdayInWindow.indexOf('runBensLeadStatusReport') === -1);
});

test('buildAndMaybeSendBensLeadStatusReport_ in preview mode logs and never sends', () => {
  const ss = { getSheetByName: (name) => {
    if (name === gas.BENS_PODCAST_SYNC_CONFIG.TRACKER_SHEET_NAME) return fakeIcons100TrackerSheet(gas.BENS_PODCAST_TRACKER_HEADERS.slice(), []);
    return null;
  } };
  const originalOpen = gas.SpreadsheetApp && gas.SpreadsheetApp.openById;
  const originalResolve = gas.resolveSheet_;
  const originalSend = gas.sendBensLeadStatusReportEmail_;
  let sendCalled = false;
  gas.SpreadsheetApp = { openById: () => ss };
  gas.resolveSheet_ = () => fakeSalesCallLogSheet([]);
  gas.sendBensLeadStatusReportEmail_ = () => { sendCalled = true; };
  try {
    gas.buildAndMaybeSendBensLeadStatusReport_(true);
    assert.equal(sendCalled, false);
  } finally {
    gas.resolveSheet_ = originalResolve;
    gas.sendBensLeadStatusReportEmail_ = originalSend;
    if (originalOpen) gas.SpreadsheetApp.openById = originalOpen;
  }
});

test('installAllReadyTriggers_ sweeps orphan triggers BEFORE attempting any install*Trigger() call, so a later trigger-cap throw cannot make the sweep unreachable (real outage, 11/09/2026: installPhase17To19StandingChecksTrigger threw "too many triggers" and the sweep, which used to run at the very end, never got a chance to free the stale slots that caused it)', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalInstallAutomation = gas.installAutomation;
  try {
    gas.ScriptApp = fakeScriptAppTriggers_(['someStaleOrphanHandler_']);
    gas.installAutomation = () => { throw new Error('simulated: too many triggers'); };
    assert.throws(() => gas.installAllReadyTriggers_(), /simulated: too many triggers/);
    const remainingHandlers = gas.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    assert.ok(remainingHandlers.indexOf('someStaleOrphanHandler_') === -1,
      'the orphan must already be swept even though installAutomation (which runs right after the sweep) threw');
  } finally {
    gas.ScriptApp = originalScriptApp;
    gas.installAutomation = originalInstallAutomation;
  }
});

// ---------------------------------------------------------------------------
// Phase 8 — reply tracker trigger consolidation (11/09/2026, real cap hit)
// ---------------------------------------------------------------------------

test('duePhase8Passes_ always includes classifyNewReplies regardless of hour', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const names = gas.duePhase8Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, 3, 0, 0), 'America/New_York').map((p) => p.name);
  assert.ok(names.indexOf('classifyNewReplies') !== -1);
});

test('duePhase8Passes_ includes sendReplyMetricsReport_ only within its own trigger-hour window', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const tz = 'America/New_York';
  const hour = gas.REPLY_TRACKER_CONFIG.DAILY_TRIGGER_HOUR;
  const inWindow = gas.duePhase8Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, hour, 0, 0), tz).map((p) => p.name);
  const outOfWindow = gas.duePhase8Passes_(gas.dateAtTimeInBusinessTimezone_(2026, 1, 1, (hour + 12) % 24, 0, 0), tz).map((p) => p.name);
  assert.ok(inWindow.indexOf('sendReplyMetricsReport_') !== -1);
  assert.ok(outOfWindow.indexOf('sendReplyMetricsReport_') === -1);
});

test('runPhase8ReplyTrackerStandingChecks_ calls only the due passes and isolates one pass throwing from the others', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const originalDue = gas.duePhase8Passes_;
  const originalAlert = gas.sendOpsAlert_;
  const calls = [];
  const alerts = [];
  gas.sendOpsAlert_ = (subject) => alerts.push(subject);
  gas.duePhase8Passes_ = () => ([
    { name: 'passA', fn: () => calls.push('passA') },
    { name: 'passB', fn: () => { throw new Error('boom'); } }
  ]);
  try {
    gas.runPhase8ReplyTrackerStandingChecks_();
    assert.deepEqual(calls, ['passA']);
    assert.deepEqual(alerts, ['Standing check error: passB']);
  } finally {
    gas.duePhase8Passes_ = originalDue;
    gas.sendOpsAlert_ = originalAlert;
  }
});

test('installReplyTrackerTriggers installs ONE every-4h trigger, sweeping any old classifyNewReplies/sendReplyMetricsReport_ triggers from before the consolidation', () => {
  const deleted = [];
  let createdConfig = null;
  const fakeTriggerBuilder = {
    timeBased: () => fakeTriggerBuilder,
    everyHours: (h) => { createdConfig = { everyHours: h }; return fakeTriggerBuilder; },
    create: () => { createdConfig.created = true; }
  };
  const oldTrigger1 = { getHandlerFunction: () => 'classifyNewReplies' };
  const oldTrigger2 = { getHandlerFunction: () => 'sendReplyMetricsReport_' };
  const unrelatedTrigger = { getHandlerFunction: () => 'someOtherTrigger' };
  const originalScriptApp = gas.ScriptApp;
  gas.ScriptApp = {
    getProjectTriggers: () => [oldTrigger1, oldTrigger2, unrelatedTrigger],
    deleteTrigger: (t) => deleted.push(t),
    newTrigger: () => fakeTriggerBuilder
  };
  try {
    gas.installReplyTrackerTriggers();
    assert.deepEqual(deleted, [oldTrigger1, oldTrigger2]);
    assert.equal(createdConfig.everyHours, 4);
    assert.equal(createdConfig.created, true);
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

test('STANDING_AUTOMATION_HANDLERS_ recognizes runEvery4HourStandingChecks_ and no longer separately recognizes classifyNewReplies/sendReplyMetricsReport_/runPhase8ReplyTrackerStandingChecks_ (merged further, 11/09/2026 -- any gap here would mean installAllReadyTriggers_ sweeps the wrong thing as an orphan)', () => {
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runEvery4HourStandingChecks_') !== -1);
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('classifyNewReplies') === -1);
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('sendReplyMetricsReport_') === -1);
  assert.ok(gas.STANDING_AUTOMATION_HANDLERS_.indexOf('runPhase8ReplyTrackerStandingChecks_') === -1);
});

test('installAllReadyTriggers_ installs the Phase 8 reply tracker trigger even when REPLY_TRACKER_CONFIG.ENABLED is false, since the classify pass runs regardless of that flag (real gap found live 11/09/2026: this used to be gated on ENABLED, so a fresh/full re-run with the flag false -- its actual current state -- would never install or migrate this trigger at all)', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalInstallAutomation = gas.installAutomation;
  const originalInstallPhase2Trigger = gas.installPhase2Trigger;
  const originalInstallSean = gas.installSeanScoringAutomation;
  const originalInstallTomas = gas.installTomasScoringAutomation;
  const originalInstallJoana = gas.installJoanaScoringAutomation;
  const originalInstallBens = gas.installBensScoringAutomation;
  const configFlags = ['HANDOFF_CONFIG', 'INBOX_SLA_CONFIG', 'WEEKLY_SCORECARD_CONFIG', 'TRAINING_REVIEW_CONFIG',
    'TOMAS_TRANSCRIPT_REMINDER_CONFIG', 'DAILY_PRACTICE_CONFIG', 'RANDOM_CALIBRATION_CONFIG', 'REPLY_TRACKER_CONFIG',
    'PLAYBOOK_REVIEW_CONFIG', 'WEEKLY_TRAINING_SUMMARY_CONFIG', 'GHL_CONFIG'];
  const originalEnabled = {};
  try {
    gas.ScriptApp = fakeScriptAppTriggers_([]);
    gas.installAutomation = () => {};
    gas.installPhase2Trigger = () => {};
    gas.installSeanScoringAutomation = () => {};
    gas.installTomasScoringAutomation = () => {};
    gas.installJoanaScoringAutomation = () => {};
    gas.installBensScoringAutomation = () => {};
    configFlags.forEach((name) => { originalEnabled[name] = gas[name].ENABLED; gas[name].ENABLED = false; });

    const originalLog = gas.Logger.log;
    const lines = [];
    gas.Logger.log = (msg) => lines.push(msg);
    try {
      gas.installAllReadyTriggers_();
    } finally {
      gas.Logger.log = originalLog;
    }

    const remainingHandlers = gas.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    assert.ok(remainingHandlers.indexOf('runEvery4HourStandingChecks_') !== -1,
      'the merged every-4h trigger (covering reply tracker among others) must be installed even with REPLY_TRACKER_CONFIG.ENABLED false');
  } finally {
    gas.ScriptApp = originalScriptApp;
    gas.installAutomation = originalInstallAutomation;
    gas.installPhase2Trigger = originalInstallPhase2Trigger;
    gas.installSeanScoringAutomation = originalInstallSean;
    gas.installTomasScoringAutomation = originalInstallTomas;
    gas.installJoanaScoringAutomation = originalInstallJoana;
    gas.installBensScoringAutomation = originalInstallBens;
    configFlags.forEach((name) => { gas[name].ENABLED = originalEnabled[name]; });
  }
});

test('sendRepRecordingsReminder_ includes a tracker-check reminder alongside the recordings check (Tomás\'s ask, 11/09/2026: "make sure tracker and uploads are on track" -- rides the existing Friday trigger rather than a new one, since the project is at the 20-trigger cap)', () => {
  const sentEmails = [];
  const originalSend = gas.MailApp.sendEmail;
  const originalAudit = gas.auditConfig_;
  const originalQuota = gas.MailApp.getRemainingDailyQuota;
  gas.MailApp.sendEmail = (to, subject, body, options) => sentEmails.push({ to, subject, body, options });
  gas.auditConfig_ = () => ({ ok: true });
  gas.MailApp.getRemainingDailyQuota = () => 100;
  try {
    gas.sendRepRecordingsReminder_();
    assert.equal(sentEmails.length, 1);
    const body = sentEmails[0].body;
    assert.ok(body.indexOf('tracker') !== -1, 'body must mention the tracker check');
    assert.ok(body.indexOf('Icons Podcast Recordings') !== -1, "Bens's tracker must be named");
    assert.ok(body.indexOf('14VS-se3Cc9jiPYlVex-5MX69ATmwSHhf0xPd6eAEiY0') !== -1, "Joana's tracker sheet must be linked");
    assert.ok(body.indexOf('1SWh26GYP2G4wojtVcKgwyW9PDZcpfAuq5hbH7P8FC7o') !== -1, "Tomás's tracker sheet must be linked");
  } finally {
    gas.MailApp.sendEmail = originalSend;
    gas.auditConfig_ = originalAudit;
    gas.MailApp.getRemainingDailyQuota = originalQuota;
  }
});

// ---------------------------------------------------------------------------
// Every-4h standing checks merge (Phase 2 + 8 + 12, 11/09/2026)
// ---------------------------------------------------------------------------

test('runEvery4HourStandingChecks_ calls all three merged passes and isolates one throwing from the others', () => {
  const originalScoring = gas.runAllOngoingScoringPasses_;
  const originalNoteSync = gas.runGhlNoteSync_;
  const originalReplyTracker = gas.runPhase8ReplyTrackerStandingChecks_;
  const originalAlert = gas.sendOpsAlert_;
  const calls = [];
  const alerts = [];
  gas.sendOpsAlert_ = (subject) => alerts.push(subject);
  gas.runAllOngoingScoringPasses_ = () => calls.push('scoring');
  gas.runGhlNoteSync_ = () => { throw new Error('boom'); };
  gas.runPhase8ReplyTrackerStandingChecks_ = () => calls.push('replyTracker');
  try {
    gas.runEvery4HourStandingChecks_();
    assert.deepEqual(calls, ['scoring', 'replyTracker']);
    assert.deepEqual(alerts, ['Standing check error: runGhlNoteSync_']);
  } finally {
    gas.runAllOngoingScoringPasses_ = originalScoring;
    gas.runGhlNoteSync_ = originalNoteSync;
    gas.runPhase8ReplyTrackerStandingChecks_ = originalReplyTracker;
    gas.sendOpsAlert_ = originalAlert;
  }
});

test('installEvery4HourStandingChecksTrigger removes old copies of all three formerly-separate triggers plus any prior copy of its own, installing exactly one combined trigger', () => {
  const originalScriptApp = gas.ScriptApp;
  gas.ScriptApp = fakeScriptAppTriggers_(
    ['runAllOngoingScoringPasses_', 'runGhlNoteSync_', 'runPhase8ReplyTrackerStandingChecks_',
      'runEvery4HourStandingChecks_', 'someUnrelatedHandler_']
  );
  try {
    gas.installEvery4HourStandingChecksTrigger();
    const handlerNames = gas.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
    assert.deepEqual(handlerNames.filter((h) => h === 'runEvery4HourStandingChecks_').length, 1);
    assert.ok(handlerNames.indexOf('runAllOngoingScoringPasses_') === -1);
    assert.ok(handlerNames.indexOf('runGhlNoteSync_') === -1);
    assert.ok(handlerNames.indexOf('runPhase8ReplyTrackerStandingChecks_') === -1);
    assert.ok(handlerNames.indexOf('someUnrelatedHandler_') !== -1, 'must not touch unrelated triggers');
  } finally {
    gas.ScriptApp = originalScriptApp;
  }
});

test('SELF_HEAL_TRIGGER_REGISTRY_ repairs runEvery4HourStandingChecks_, not the narrower runAllOngoingScoringPasses_ it superseded (real regression risk, 11/09/2026: leaving the old handler here would make self-heal recreate a standalone trigger weekly, silently undoing the slot savings)', () => {
  const entry = gas.SELF_HEAL_TRIGGER_REGISTRY_.filter((e) => e.pauseProperty === 'PAUSE_ONGOING_SCORING_TRIGGER')[0];
  assert.ok(entry, 'the ongoing-scoring self-heal entry must still exist');
  assert.equal(entry.handler, 'runEvery4HourStandingChecks_');
  assert.equal(entry.install, gas.installEvery4HourStandingChecksTrigger);
});
