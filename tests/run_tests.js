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
 * "+HHMM"/"-HHMM" offset, and 'yyyy').
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
  throw new Error('realFormatDate: unsupported pattern "' + pattern + '"');
}

const gas = loadGasProject(path.join(__dirname, '..'));

test('idsEqual_ treats a bare ID and its @google.com-suffixed form as equal', () => {
  assert.equal(gas.idsEqual_('abc123', 'abc123@google.com'), true);
  assert.equal(gas.idsEqual_('abc123', 'xyz789'), false);
});

test('parseLegacyFilename_ parses the YYYY-MM-DD_ProspectName_Transcript.txt convention and splits CamelCase names', () => {
  const parsed = gas.parseLegacyFilename_('2026-08-14_LeiMcDonald_Transcript.txt');
  assert.equal(parsed.dateStr, '2026-08-14');
  assert.equal(parsed.prospectName, 'Lei Mc Donald'); // documented best-effort split; rawSlug keeps the original
  assert.equal(parsed.rawSlug, 'LeiMcDonald');
});

test('parseLegacyFilename_ returns null for a filename that does not match the convention', () => {
  assert.equal(gas.parseLegacyFilename_('random_video.mp4'), null);
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

test('computeRepWeeklyStats_ separates this week\'s calls from historic ones, per rep, and tallies flags/failure modes', () => {
  const weekStart = new gas.Date(2026, 7, 10);
  const weekEnd = new gas.Date(2026, 7, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: new gas.Date(2026, 7, 11), score: 4, pfm: 'no_close_ask', askedForClose: false, objectionsHandled: true }),
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: new gas.Date(2026, 7, 12), score: 2, pfm: 'no_close_ask', askedForClose: false, objectionsHandled: false }),
    scorecardRow(gas, { rep: 'Sean', name: 'C', date: new gas.Date(2026, 7, 3), score: 5, pfm: 'none', askedForClose: true, objectionsHandled: true }), // before the week
    scorecardRow(gas, { rep: 'Bens', name: 'D', date: new gas.Date(2026, 7, 11), score: 1, pfm: 'objections_missed', askedForClose: true, objectionsHandled: false }) // different rep
  ];

  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd);
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
  const weekStart = new gas.Date(2026, 7, 10);
  const weekEnd = new gas.Date(2026, 7, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: new gas.Date(2026, 7, 11), score: 4, askedForClose: true, objectionsHandled: true }),
    // 40 days before weekEnd — outside the 28-day rolling window entirely.
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: new gas.Date(2026, 6, 8), score: 1, askedForClose: true, objectionsHandled: true })
  ];

  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd);
  assert.equal(stats.rolling4WeekCount, 1);
  assert.equal(stats.rolling4WeekAvg, 4);
  // The old call is still counted in the all-time historic average, just not the rolling one.
  assert.equal(stats.historicCount, 2);
});

test('computeRepWeeklyStats_ identifies the week\'s lowest-scoring call as worstCall, carrying its feedback summary', () => {
  const weekStart = new gas.Date(2026, 7, 10);
  const weekEnd = new gas.Date(2026, 7, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: new gas.Date(2026, 7, 11), score: 4, feedbackSummary: 'Good call.' }),
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: new gas.Date(2026, 7, 12), score: 2, feedbackSummary: '"I guess we could talk price" — you let that sit instead of isolating it.' })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd);
  assert.equal(stats.worstCall.name, 'B');
  assert.equal(stats.worstCall.score, 2);
  assert.ok(stats.worstCall.feedbackSummary.indexOf('isolating') !== -1);
});

test('computeRepWeeklyStats_ counts this week\'s calls missing an Outcome Disposition', () => {
  const weekStart = new gas.Date(2026, 7, 10);
  const weekEnd = new gas.Date(2026, 7, 17);
  const rows = [
    scorecardRow(gas, { rep: 'Sean', name: 'A', date: new gas.Date(2026, 7, 11), score: 4, outcomeDisposition: 'Sold' }),
    scorecardRow(gas, { rep: 'Sean', name: 'B', date: new gas.Date(2026, 7, 12), score: 2, outcomeDisposition: '' }),
    // Before this week — should not count toward the weekly figure.
    scorecardRow(gas, { rep: 'Sean', name: 'C', date: new gas.Date(2026, 7, 3), score: 3, outcomeDisposition: '' })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd);
  assert.equal(stats.weekMissingOutcomeDisposition, 1);
});

test('computeRepWeeklyStats_ worstCall is null when the rep had no calls this week', () => {
  const weekStart = new gas.Date(2026, 7, 10);
  const weekEnd = new gas.Date(2026, 7, 17);
  const stats = gas.computeRepWeeklyStats_([], SCORECARD_COL, 'Sean', weekStart, weekEnd);
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
