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
  throw new Error('realFormatDate: unsupported pattern "' + pattern + '"');
}

const gas = loadGasProject(path.join(__dirname, '..'));

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

test('guessProspectFromTitle_ extracts the prospect name from the real calendar title patterns it documents', () => {
  assert.equal(
    gas.guessProspectFromTitle_('Podcast Qualification Call / Tom Wood and ICONS of Real Estate'),
    'Tom Wood'
  );
  assert.equal(gas.guessProspectFromTitle_('Real Estate Podcast: Andrea Brunson'), 'Andrea Brunson');
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
    flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
    manual_review_recommended: false,
    severity: 2
  };
  assert.equal(gas.isValidJudgeSchema_(good), true);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, good, { severity: undefined })), false);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, good, { framework: undefined })), false);
  assert.equal(gas.isValidJudgeSchema_(null), false);
});

test('deriveFrameworkFields_ — all three explained means no gaps; a missing framework object means every gap listed, not a throw', () => {
  // Return values come from the vm sandbox's own realm, so assert.deepEqual's
  // prototype-identity check would fail against this file's plain object
  // literals for realm reasons, not a real mismatch — compare fields directly,
  // same convention as stripFencesAndParseJson_'s test above.
  const allExplained = gas.deriveFrameworkFields_({
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true }
  });
  assert.equal(allExplained.explained, true);
  assert.equal(allExplained.gapsText, '');

  const oneGap = gas.deriveFrameworkFields_({
    framework: { recruit_agents_explained: true, number_one_podcast_explained: false, sell_more_houses_explained: true }
  });
  assert.equal(oneGap.explained, false);
  assert.equal(oneGap.gapsText, '#1 podcast in your city');

  // Parse-failure fallbacks and any result shape predating this field must not throw —
  // conservative default is "nothing explained", same policy as manual_review_recommended.
  const missingObject = gas.deriveFrameworkFields_({});
  assert.equal(missingObject.explained, false);
  assert.equal(missingObject.gapsText, 'recruit agents, #1 podcast in your city, sell more houses');

  const nullResult = gas.deriveFrameworkFields_(null);
  assert.equal(nullResult.explained, false);
  assert.equal(nullResult.gapsText, 'recruit agents, #1 podcast in your city, sell more houses');
});

test('findColumn_ matches header names case-insensitively and tries candidates in priority order', () => {
  const header = ['Name', 'Call Taken', 'Comments'];
  assert.equal(gas.findColumn_(header, ['Outcome Logged', 'Call Taken']), 1);
  assert.equal(gas.findColumn_(header, ['Nonexistent']), -1);
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

test('pickDuplicateRowsToDelete_ leaves distinct (rep, name, date) rows alone', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'A', dateKey: '2026-08-17', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 3, rep: 'Bens', prospectName: 'B', dateKey: '2026-08-17', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
  ];
  assert.equal(gas.pickDuplicateRowsToDelete_(rows).length, 0);
});

test('pickDuplicateRowsToDelete_ never touches exact_key rows, even with a repeated (name, date)', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'A', dateKey: '2026-08-17', matchMethod: 'exact_key', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 3, rep: 'Bens', prospectName: 'A', dateKey: '2026-08-17', matchMethod: 'exact_key', reviewedByKris: false, krisVerdict: '' }
  ];
  assert.equal(gas.pickDuplicateRowsToDelete_(rows).length, 0);
});

test('pickDuplicateRowsToDelete_ keeps the lowest row number among otherwise-equal duplicates, deletes the rest', () => {
  const rows = [
    { rowIndex: 5, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 2, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 9, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
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
    { rowIndex: 2, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 20, rep: 'Bens', prospectName: 'Rebecca Stewart', dateKey: '2026-08-17', matchMethod: 'fallback_heuristic', reviewedByKris: true, krisVerdict: 'Yes' }
  ];
  const toDelete = gas.pickDuplicateRowsToDelete_(rows);
  assert.equal(toDelete.length, 1);
  assert.equal(toDelete[0].rowIndex, 2, 'should delete the unreviewed row, keeping the one with a real Kris verdict');
});

test('pickDuplicateRowsToDelete_ groups separately per rep even with the same name/date', () => {
  const rows = [
    { rowIndex: 2, rep: 'Bens', prospectName: 'Chad Davis', dateKey: '2026-08-11', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' },
    { rowIndex: 3, rep: 'Sean', prospectName: 'Chad Davis', dateKey: '2026-08-11', matchMethod: 'fallback_heuristic', reviewedByKris: false, krisVerdict: '' }
  ];
  assert.equal(gas.pickDuplicateRowsToDelete_(rows).length, 0);
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
  'AI Feedback Summary': 8, 'Outcome Disposition': 9
};

function scorecardRow(gas, { rep, name, date, score, pfm, askedForClose, objectionsHandled, feedbackSummary, outcomeDisposition }) {
  return [rep, name, date, score, pfm || '', askedForClose, objectionsHandled, feedbackSummary || '', outcomeDisposition || ''];
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
    worstCall: { name: 'Jane Doe', score: 2, feedbackSummary: '"I guess we could talk price" — you let that sit instead of isolating it.' },
    weekFailureModes: ['objections_missed'],
    weekFlagMiss: { askedForClose: 0, objectionsHandled: 1 },
    weekMissingOutcomeDisposition: 1
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
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
    manual_review_recommended: false,
    severity: 1,
    feedback_summary: 'string',
    primary_failure_mode: 'none'
  };
  gas.writeScoreToRow_(fakeSheet, 7, col, result, false);

  assert.equal(cells['7:' + col['Rubric Version']], gas.RUBRIC_VERSION);
});

// --- Task: frozen regression set / drift detection (25/08/2026) ---

test('resolveRubricVariantForRow_ maps exact_key rows to the shared rubric regardless of rep', () => {
  assert.equal(gas.resolveRubricVariantForRow_('Sean', 'exact_key'), 'shared');
  assert.equal(gas.resolveRubricVariantForRow_('Bens', 'exact_key'), 'shared');
  assert.equal(gas.resolveRubricVariantForRow_('Tomás', 'exact_key'), 'shared');
});

test('resolveRubricVariantForRow_ maps fallback_heuristic rows to each rep\'s own variant, and Joana to the shared rubric', () => {
  assert.equal(gas.resolveRubricVariantForRow_('Sean', 'fallback_heuristic'), 'sean');
  assert.equal(gas.resolveRubricVariantForRow_('Bens', 'fallback_heuristic'), 'bens');
  assert.equal(gas.resolveRubricVariantForRow_('Tomás', 'fallback_heuristic'), 'tomas');
  assert.equal(gas.resolveRubricVariantForRow_('Joana', 'fallback_heuristic'), 'shared');
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

  assert.equal(gas.scoreTranscriptByVariant_('sean', {}), 'sean-result');
  assert.equal(gas.scoreTranscriptByVariant_('bens', {}), 'bens-result');
  assert.equal(gas.scoreTranscriptByVariant_('tomas', {}), 'tomas-result');
  assert.equal(gas.scoreTranscriptByVariant_('shared', {}), 'shared-result');
  assert.deepEqual(calls, ['sean', 'bens', 'tomas', 'shared']);
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
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true }
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
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true }
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
      interview_content_quality_good: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true }
  };
}
function perfectTomasResult_() {
  return {
    call_quality_score: 5,
    flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true }
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
  frameworkMissOnly.framework.sell_more_houses_explained = false; // any single gap is enough to fail deriveFrameworkFields_'s "explained"
  assert.equal(gas.computeSharedAnalyticScore_(frameworkMissOnly), 4);
});

test('computeSharedAnalyticScore_ floors at 1 when every deduction fires', () => {
  const worst = perfectSharedResult_();
  worst.flags.asked_for_close = false;
  worst.flags.objections_uncovered = false;
  worst.framework.recruit_agents_explained = false;
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
  frameworkMiss.framework.number_one_podcast_explained = false;
  assert.equal(gas.computeTomasAnalyticScore_(frameworkMiss), 4);
});

test('computeAnalyticScore_ dispatches to the matching per-variant function, defaulting unknown variants to shared', () => {
  assert.equal(gas.computeAnalyticScore_('sean', perfectSeanResult_()), 5);
  assert.equal(gas.computeAnalyticScore_('bens', perfectBensResult_()), 5);
  assert.equal(gas.computeAnalyticScore_('tomas', perfectTomasResult_()), 5);
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
    framework: { recruit_agents_explained: false, number_one_podcast_explained: false, sell_more_houses_explained: false },
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
    practiced_framework: true,
    coaching_notes: 'Solid call, no objections came up.',
    next_focus: 'Keep it up.',
    team_notes: '',
    objections_to_drill: [],
    close_ask_drill: { label: 'Ask for the appointment', note: 'Nailed it.' },
    framework_gaps_to_drill: []
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
  const result = {
    attended: true, practiced_objections: true, practiced_close_ask: false, practiced_framework: false,
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
  const result = {
    attended: true, practiced_objections: true, practiced_close_ask: true, practiced_framework: false,
    coaching_notes: 'Notes here', next_focus: 'focus', objections_to_drill: [{ label: 'Budget', note: 'agree/isolate/repeat' }],
    close_ask_drill: { label: 'Ready to get started?', note: 'ask again on objection' },
    framework_gaps_to_drill: [{ topic: 'sell_more_houses', note: 'say this' }], team_notes: 'none'
  };
  const email = gas.buildTrainingReviewEmail_('Sean', '260825', result);
  assert.ok(email.body.indexOf('Practiced asking for the money') !== -1);
  assert.ok(email.body.indexOf('Framework explanation to drill') !== -1);
  assert.ok(email.htmlBody.indexOf('Framework explanation practiced') !== -1);
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
    flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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

test('escapeHtml_ neutralizes a raw "Name <addr>" From header and stray angle brackets (real bug: unescaped fromRaw/subject broke HTML rendering in the nudge email)', () => {
  assert.equal(gas.escapeHtml_('Margaret Chen <margaret@bhhsrealty.com>'), 'Margaret Chen &lt;margaret@bhhsrealty.com&gt;');
  assert.equal(gas.escapeHtml_('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(gas.escapeHtml_('Tom & Jerry'), 'Tom &amp; Jerry');
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
  gas.Utilities = { sleep: () => {} };
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
