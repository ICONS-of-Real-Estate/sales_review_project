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
  const lines = [];
  try {
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
  'AI Feedback Summary': 8, 'Outcome Disposition': 9, 'Transcript URL': 10, 'Manual Review Recommended': 11
};

function scorecardRow(gas, { rep, name, date, score, pfm, askedForClose, objectionsHandled, feedbackSummary, outcomeDisposition, transcriptUrl, manualReviewRecommended }) {
  return [rep, name, date, score, pfm || '', askedForClose, objectionsHandled, feedbackSummary || '', outcomeDisposition || '', transcriptUrl || '', manualReviewRecommended === true];
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

test('computeRepWeeklyStats_ carries transcriptUrl and manualReviewRecommended into each week call (Kris\'s ask 01/09/2026: no way to check the actual transcript, and a manual-review-flagged call read as if it were real coaching feedback)', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const weekStart = bizDate(gas, 2026, 8, 10);
  const weekEnd = bizDate(gas, 2026, 8, 17);
  const rows = [
    scorecardRow(gas, {
      rep: 'Sean', name: 'A', date: bizDate(gas, 2026, 8, 11), score: 4,
      feedbackSummary: 'Fine call.', transcriptUrl: 'https://docs.google.com/document/d/abc/edit',
      manualReviewRecommended: false
    }),
    scorecardRow(gas, {
      rep: 'Sean', name: 'B', date: bizDate(gas, 2026, 8, 12), score: 1,
      feedbackSummary: 'The only thing on this record is "[BLANK_AUDIO]".', transcriptUrl: 'https://docs.google.com/document/d/xyz/edit',
      manualReviewRecommended: true
    })
  ];
  const stats = gas.computeRepWeeklyStats_(rows, SCORECARD_COL, 'Sean', weekStart, weekEnd, gas.CONFIG.BUSINESS_TIMEZONE);
  assert.equal(stats.worstCall.name, 'B');
  assert.equal(stats.worstCall.transcriptUrl, 'https://docs.google.com/document/d/xyz/edit');
  assert.equal(stats.worstCall.manualReviewRecommended, true);
  const callA = stats.weekCalls.filter((c) => c.name === 'A')[0];
  assert.equal(callA.transcriptUrl, 'https://docs.google.com/document/d/abc/edit');
  assert.equal(callA.manualReviewRecommended, false);
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
      name: 'Jane Doe', score: 2,
      feedbackSummary: '"I guess we could talk price" — you let that sit instead of isolating it.',
      transcriptUrl: 'https://docs.google.com/document/d/abc123/edit',
      manualReviewRecommended: false
    },
    weekFailureModes: ['objections_missed'],
    weekFlagMiss: { askedForClose: 0, objectionsHandled: 1 },
    weekMissingOutcomeDisposition: 1
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
  assert.ok(email.htmlBody.indexOf('Dave Gove') !== -1 && email.htmlBody.indexOf('Jane Doe') !== -1,
    'every this-week call must be listed, not just the worst one');
});

test('buildWeeklyScorecardEmail_ clearly flags a manual-review call instead of letting it read as real coaching feedback (Kris\'s real complaint: a [BLANK_AUDIO] recording failure was buried in prose with no indication the AI couldn\'t actually grade it)', () => {
  const stats = {
    weekCalls: [{ name: 'April Stephens', score: 1 }],
    weeklyAvg: 1, historicAvg: 3, historicAvgBeforeThisWeek: 3, historicCount: 5,
    rolling4WeekAvg: 3, rolling4WeekCount: 5,
    worstCall: {
      name: 'April Stephens', score: 1,
      feedbackSummary: 'The only thing on this record is "[BLANK_AUDIO]" repeated for the entire call.',
      transcriptUrl: '',
      manualReviewRecommended: true
    },
    weekFailureModes: [], weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }, weekMissingOutcomeDisposition: 0
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

  assert.match(email.body, /Flagged for manual review/, 'plain-text body must say clearly that the AI could not grade this, not bury it in the feedback prose');
  assert.match(email.htmlBody, /Flagged for manual review/, 'htmlBody must say the same thing clearly');
  assert.match(email.body, /no transcript on file/, 'a missing transcript must be stated plainly, not silently omitted');
  assert.match(email.htmlBody, /no transcript on file/);
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

test('buildWeeklyTrainingSummaryContent_ carries the manual-review flag and transcript link through, same as buildWeeklyScorecardEmail_\'s own stats', () => {
  const stats = {
    weekCalls: [{ name: 'April Stephens', score: 1 }, { name: 'Dave Gove', score: 4 }],
    weeklyAvg: 2.5, historicAvg: 3, historicAvgBeforeThisWeek: 3, historicCount: 5,
    rolling4WeekAvg: 3, rolling4WeekCount: 5,
    worstCall: {
      name: 'April Stephens', score: 1,
      feedbackSummary: 'The only thing on this record is "[BLANK_AUDIO]" repeated for the entire call.',
      transcriptUrl: 'https://docs.google.com/document/d/abc/edit',
      manualReviewRecommended: true
    },
    weekFailureModes: [], weekFlagMiss: { askedForClose: 0, objectionsHandled: 0 }, weekMissingOutcomeDisposition: 2
  };
  const content = gas.buildWeeklyTrainingSummaryContent_('Joana', stats, '24/08–30/08/2026');
  assert.equal(content.repName, 'Joana');
  assert.equal(content.hasCalls, true);
  assert.equal(content.worstCall.name, 'April Stephens');
  assert.equal(content.worstCall.manualReviewRecommended, true);
  assert.equal(content.worstCall.transcriptUrl, 'https://docs.google.com/document/d/abc/edit');
  assert.equal(content.weekCalls.length, 2);
  assert.equal(content.weekMissingOutcomeDisposition, 2);
  assert.ok(content.priority, 'expected a priority string, even a fallback one');
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
});

// --- Task: frozen regression set / drift detection (25/08/2026) ---

test('resolveRubricVariantForRow_ maps exact_key rows to the shared rubric for Sean/Bens, but Tomás always gets his own variant regardless of match method (real gap closed 29/08/2026: his own live-logged calls never got his rubric before this)', () => {
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

  assert.equal(gas.scoreTranscriptByVariant_('sean', {}), 'sean-result');
  assert.equal(gas.scoreTranscriptByVariant_('bens', {}), 'bens-result');
  assert.equal(gas.scoreTranscriptByVariant_('tomas', {}), 'tomas-result');
  assert.equal(gas.scoreTranscriptByVariant_('qc', {}), 'qc-result');
  assert.equal(gas.scoreTranscriptByVariant_('shared', {}), 'shared-result');
  assert.deepEqual(calls, ['sean', 'bens', 'tomas', 'qc', 'shared']);
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
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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
      interview_content_quality_good: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
    delivery: { paced_appropriately: true, adapted_to_lead_engagement: true }
  };
}
function perfectQcResult_() {
  return {
    call_quality_score: 5,
    flags: {
      asked_for_close: true, objections_uncovered: true, objections_overcome: true,
      booked_next_step: true, discovery_adequate: true, understood_leads_business: true
    },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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
  frameworkMissOnly.framework.sell_more_houses_explained = false; // any single gap is enough to fail deriveFrameworkFields_'s "explained"
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
    getLastColumn: () => 7, // already has the "Matched File" column — no header migration needed
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

test('buildPlaybookReviewNewMaterialEmail_ subject drops the year (Kris\'s ask 02/09/2026: "we know what year it is"), but the body keeps full dates', () => {
  const repCfg = { name: 'Sean' };
  const flagged = [{ prospectName: 'Bruce Henson', callDate: '27/08/2026', score: 4, feedback: 'ok' }];
  const email = gas.buildPlaybookReviewNewMaterialEmail_(repCfg, flagged, '24/08/2026 - 30/08/2026');

  assert.equal(email.subject, 'Sean — last week\'s calls to review (24/08 - 30/08)');
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

test('stripYearFromDateRangeLabel_ strips every /yyyy year suffix out of a date-range label', () => {
  assert.equal(gas.stripYearFromDateRangeLabel_('24/08/2026 - 30/08/2026'), '24/08 - 30/08');
  assert.equal(gas.stripYearFromDateRangeLabel_('01/09/2026'), '01/09');
  assert.equal(gas.stripYearFromDateRangeLabel_('no dates here'), 'no dates here');
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
    practiced_framework: true,
    coaching_notes: 'Solid call, no objections came up.',
    next_focus: 'Keep it up.',
    team_notes: '',
    objections_to_drill: [],
    close_ask_drill: { label: 'Ask for the appointment', note: 'Nailed it.' },
    framework_gaps_to_drill: [],
    tomas_coaching: {
      grounded_in_real_data: true,
      gave_concrete_next_focus: true,
      coaching_feedback_summary: 'Grounded in a real objection from this call.'
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
  gas.Utilities = { formatDate: realFormatDate };
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
    attended: true, practiced_objections: true, practiced_close_ask: false, practiced_framework: false,
    coaching_notes: 'Notes here', next_focus: 'focus', objections_to_drill: [{ label: 'Too busy', note: 'agree/isolate/repeat' }],
    close_ask_drill: null, framework_gaps_to_drill: [], team_notes: 'none'
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
    attended: true, practiced_objections: false, practiced_close_ask: true, practiced_framework: true,
    coaching_notes: 'Solid call.', next_focus: 'Keep it up.', team_notes: '',
    objections_to_drill: [], close_ask_drill: { label: 'Ask for the appointment', note: 'Nailed it.' },
    framework_gaps_to_drill: [],
    tomas_coaching: {
      grounded_in_real_data: true,
      gave_concrete_next_focus: true,
      coaching_feedback_summary: 'Grounded the session in a real objection from this week.'
    }
  };
  assert.equal(gas.isValidTrainingReviewSchema_(base), true);

  const missing = Object.assign({}, base);
  delete missing.tomas_coaching;
  assert.equal(gas.isValidTrainingReviewSchema_(missing), false, 'missing tomas_coaching must fail validation');

  const malformed = Object.assign({}, base, {
    tomas_coaching: { grounded_in_real_data: 'yes', gave_concrete_next_focus: true, coaching_feedback_summary: 'ok' }
  });
  assert.equal(gas.isValidTrainingReviewSchema_(malformed), false, 'non-boolean grounded_in_real_data must fail validation');
});

test('reviewTrainingCallTranscript_\'s parse-failure fallback carries a tomas_coaching stub, so buildTomasCoachingFeedbackEmail_ never sees an undefined field', () => {
  gas.Utilities = { formatDate: realFormatDate };
  gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 0 };
  gas.callKimiJudge_ = () => 'not json';
  const result = gas.reviewTrainingCallTranscript_('Sean', 'transcript text', '260825');
  assert.ok(result.tomas_coaching, 'fallback must include a tomas_coaching object');
  assert.equal(result.tomas_coaching.grounded_in_real_data, false);
  assert.equal(result.tomas_coaching.gave_concrete_next_focus, false);
  assert.equal(typeof result.tomas_coaching.coaching_feedback_summary, 'string');
});

test('reviewTrainingCallTranscript_\'s parse-failure fallback carries manual_review_recommended: true, so callers can tell it apart from a real score', () => {
  gas.Utilities = { formatDate: realFormatDate };
  gas.PHASE2_CONFIG = { MAX_PARSE_RETRIES: 0 };
  gas.callKimiJudge_ = () => 'not json';
  const result = gas.reviewTrainingCallTranscript_('Sean', 'transcript text', '260825');
  assert.equal(result.manual_review_recommended, true);
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

test('buildTomasCoachingFeedbackEmail_ derives rep_got_to_practice from the judge\'s own practiced_* fields rather than asking a second question, and skips framework for Bens', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const coaching = { grounded_in_real_data: true, gave_concrete_next_focus: false, coaching_feedback_summary: 'Leaned on generic advice instead of Bens\' real calls.' };

  // Bens: no objection/close practice this call, but framework doesn't count for him anyway.
  const bensResult = {
    practiced_objections: false, practiced_close_ask: false, practiced_framework: true,
    tomas_coaching: coaching
  };
  const bensEmail = gas.buildTomasCoachingFeedbackEmail_('Bens', '260825', bensResult);
  assert.ok(bensEmail.body.indexOf('got to practice out loud: No') !== -1,
    'Bens practiced neither objections nor the close-ask, and framework never counts for him');

  // Sean: didn't practice objections/close, but DID drill framework — should count as having practiced.
  const seanResult = {
    practiced_objections: false, practiced_close_ask: false, practiced_framework: true,
    tomas_coaching: coaching
  };
  const seanEmail = gas.buildTomasCoachingFeedbackEmail_('Sean', '260825', seanResult);
  assert.ok(seanEmail.body.indexOf('got to practice out loud: Yes') !== -1,
    'Sean\'s framework drill should count toward practice since his role covers it');
});

test('buildTomasCoachingFeedbackEmail_ subject carries the week number and stays distinct from the rep\'s own Training Call Plan subject', () => {
  gas.Utilities = { formatDate: realFormatDate };
  const result = {
    practiced_objections: true, practiced_close_ask: true, practiced_framework: true,
    tomas_coaching: { grounded_in_real_data: true, gave_concrete_next_focus: true, coaching_feedback_summary: 'Good session.' }
  };
  const email = gas.buildTomasCoachingFeedbackEmail_('Sean', '260825', result);
  assert.equal(email.subject, 'Your Training Call Coaching Feedback — Sean — Week 2');
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

test('installAllReadyTriggers_ always stops the ad-hoc rescoreAllCalls backfill trigger, since it is not part of standing automation (real bug, 31/08/2026: Kris installed installRescoreAllCallsTrigger() directly to run the retroactive rescore, but the backfill was meant to wait on Tomás\'s calibration sign-off — a one-off trigger like this must never be left running just because the master installer got re-run for an unrelated phase)', () => {
  const originalScriptApp = gas.ScriptApp;
  const originalInstallAutomation = gas.installAutomation;
  const originalInstallPhase2Trigger = gas.installPhase2Trigger;
  const originalInstallSean = gas.installSeanScoringAutomation;
  const originalInstallTomas = gas.installTomasScoringAutomation;
  const originalInstallJoana = gas.installJoanaScoringAutomation;
  const originalInstallBens = gas.installBensScoringAutomation;
  const originalRemoveRescore = gas.removeRescoreAllCallsTrigger_;
  const configFlags = ['HANDOFF_CONFIG', 'INBOX_SLA_CONFIG', 'WEEKLY_SCORECARD_CONFIG', 'TRAINING_REVIEW_CONFIG',
    'TOMAS_TRANSCRIPT_REMINDER_CONFIG', 'DAILY_PRACTICE_CONFIG', 'RANDOM_CALIBRATION_CONFIG', 'REPLY_TRACKER_CONFIG'];
  const originalEnabled = {};
  try {
    gas.ScriptApp = fakeScriptAppTriggers_([]);
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

    let removeCalled = false;
    gas.removeRescoreAllCallsTrigger_ = () => { removeCalled = true; };

    const originalLog = gas.Logger.log;
    const lines = [];
    gas.Logger.log = (msg) => lines.push(msg);
    try {
      gas.installAllReadyTriggers_();
    } finally {
      gas.Logger.log = originalLog;
    }

    assert.equal(removeCalled, true, 'the master installer must always stop the ad-hoc rescore trigger, not just install standing phases');

    // Real bug found live (31/08/2026): every install*() call above sets its
    // own RUN_TAG, leaving it stuck on whichever ran last (here,
    // installBensScoringAutomation) by the time the "done" summary logs —
    // it showed up live as "[installReplyTrackerTriggers] installAllReadyTriggers_
    // done." instead of its own tag.
    const doneLine = lines.find((l) => l.indexOf('installAllReadyTriggers_ done.') !== -1);
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
    gas.removeRescoreAllCallsTrigger_ = originalRemoveRescore;
    configFlags.forEach((name) => { gas[name].ENABLED = originalEnabled[name]; });
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
    flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true },
    framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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

test('formatEmailAgeLabel_ stays in hours under 48h, switches to rounded days at/over 48h (Kris\'s ask 02/09/2026: "hours get a bit crazy" past 48h)', () => {
  assert.equal(gas.formatEmailAgeLabel_(0), '0h old');
  assert.equal(gas.formatEmailAgeLabel_(24), '24h old');
  assert.equal(gas.formatEmailAgeLabel_(47), '47h old');
  assert.equal(gas.formatEmailAgeLabel_(48), '2d old');
  assert.equal(gas.formatEmailAgeLabel_(169), '7d old');
  assert.equal(gas.formatEmailAgeLabel_(656), '27d old');
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

test('buildReplyMetricsReportBody_ and buildReplyMetricsReportHtml_ cap the rolling-period example replies at REPLY_EXAMPLE_LIMIT_ and note how many more are not shown (Kris\'s ask 30/08/2026: "need to show at least examples so there is some action to take")', () => {
  const now = new Date('2026-08-29T21:00:00Z');
  const rows = [];
  // 5 positive replies within the last 7 days — more than REPLY_EXAMPLE_LIMIT_ (3).
  for (let i = 0; i < 5; i++) {
    rows.push({ date: new Date(now.getTime() - i * 3600 * 1000), leadEmail: 'pos' + i + '@example.com', sentiment: 'positive', subject: 'Positive reply ' + i, reasoning: 'r' + i });
  }
  const originalBookingTabs = gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS;
  const originalUtilities = gas.Utilities;
  gas.REPLY_TRACKER_CONFIG.BOOKING_TRACKER_TABS = [];
  gas.Utilities = { formatDate: (d, tz, pattern) => (pattern === 'dd/MM/yy' ? '29/08/26' : realFormatDate(d, tz, pattern)) };
  try {
    const body = gas.buildReplyMetricsReportBody_(rows, now, 'America/New_York');
    const weekExamplesSection = body.split('Examples — positive:')[1];
    const shownInBody = (weekExamplesSection.match(/Positive reply \d/g) || []).length;
    assert.equal(shownInBody, gas.REPLY_EXAMPLE_LIMIT_, 'plain-text examples section must cap at REPLY_EXAMPLE_LIMIT_');
    assert.match(body, /\(\+2 more not shown\)/, 'must say how many additional replies were not shown');

    const html = gas.buildReplyMetricsReportHtml_(rows, now, 'America/New_York');
    const weekHtmlSection = html.split('Rolling 7-day average')[1].split('Rolling 30-day average')[0];
    const shownInHtml = (weekHtmlSection.match(/Positive reply \d/g) || []).length;
    assert.equal(shownInHtml, gas.REPLY_EXAMPLE_LIMIT_, 'HTML examples section must cap at REPLY_EXAMPLE_LIMIT_');
    assert.match(weekHtmlSection, /\(\+2 more not shown\)/, 'HTML must also say how many additional replies were not shown');
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
    gas.DriveApp = { getFileById: () => ({ getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => 'transcript text' }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };

    const scoredVariants = [];
    gas.scoreQcTranscript_ = (ctx) => {
      scoredVariants.push({ variant: 'qc', prospectName: ctx.prospectName });
      return {
        reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
        flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true },
        framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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
    gas.DriveApp = { getFileById: () => ({ getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => 'transcript text' }) }) };
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
    gas.DriveApp = { getFileById: () => ({ getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => 'transcript text' }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.Logger.log = (msg) => lines.push(msg);
    gas.scoreQcTranscript_ = () => ({
      reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
      flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true },
      framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
      delivery: { paced_appropriately: true, adapted_to_lead_engagement: true },
      primary_failure_mode: 'none', root_cause_if_no_booking: 'N/A', manual_review_recommended: false, severity: 1,
      feedback_summary: 'rescored'
    });

    gas.rescoreAllCalls_(false);

    const joined = lines.join('\n');
    assert.match(joined, /1 row\(s\) out of 1 need a rescore this pass/, 'must log the real scope up front, before any model call');
    assert.match(joined, /\[1\/1\] Rescored row 2 \(Logged Live,.*score 3 -> 4/, 'must log each row as it completes, not stay silent until the end');
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
    gas.DriveApp = { getFileById: () => ({ getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => 'transcript text' }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };

    const order = [];
    const fakeResult = (variantLabel) => {
      order.push(variantLabel);
      return {
        reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
        flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true, captured_leads_goals: true, tied_framework_to_goals: true, booked_second_call_with_tomas: true },
        framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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
    gas.DriveApp = { getFileById: () => ({ getMimeType: () => 'text/plain', getBlob: () => ({ getDataAsString: () => 'transcript text' }) }) };
    gas.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    gas.scoreQcTranscript_ = () => ({
      reasoning: 'r', lead_quality: { verdict: 'good_to_book' }, call_quality_score: 4,
      flags: { asked_for_close: true, objections_uncovered: true, objections_overcome: true, booked_next_step: true, discovery_adequate: true, understood_leads_business: true },
      framework: { recruit_agents_explained: true, number_one_podcast_explained: true, sell_more_houses_explained: true },
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
  // Chainable builder supporting both calling conventions used in this codebase:
  // .timeBased().everyMinutes(n).create() (rescore/legacy-backfill triggers) and
  // .timeBased().everyDays(1).atHour(h).inTimezone(tz).create() (Phase 1/7 daily triggers).
  const makeBuilder = (fnName) => {
    const builder = {
      everyMinutes: () => builder,
      everyDays: () => builder,
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
      getLastColumn: () => 7,
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
      getLastColumn: () => 7,
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

// --- Task: prospect social/website link lookup via Google CSE (01/09/2026) ---
// Kris's ask: the model only ever reports a link the lead said verbatim on
// the call, so "Not mentioned on this call" was the common case — find real
// social/website links via a web search instead, clearly labeled unconfirmed.

test('parseCseResults_ extracts {title, link, snippet} from a real CSE response shape, and returns [] for anything malformed', () => {
  const real = {
    items: [
      { title: 'Jane Doe Realty', link: 'https://janedoerealty.com', snippet: 'Top agent in...' },
      { title: 'Jane Doe | LinkedIn', link: 'https://linkedin.com/in/janedoe' } // no snippet key at all
    ]
  };
  // Compare fields directly, not via assert.deepEqual — parsed[0] is a plain
  // object built by object-literal syntax executing inside the vm sandbox,
  // so it fails deepEqual's cross-realm prototype-identity check against a
  // literal built in this file (same pattern noted throughout this suite,
  // e.g. the repOwnEmails_ tests above).
  const parsed = gas.parseCseResults_(real);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Jane Doe Realty');
  assert.equal(parsed[0].link, 'https://janedoerealty.com');
  assert.equal(parsed[0].snippet, 'Top agent in...');
  assert.equal(parsed[1].snippet, '', 'a missing snippet key must default to empty string, not throw');

  assert.equal(gas.parseCseResults_(null).length, 0);
  assert.equal(gas.parseCseResults_({}).length, 0, 'no items array at all (e.g. a quota-error response) must not throw');
  assert.equal(gas.parseCseResults_({ items: 'not-an-array' }).length, 0);
  assert.equal(gas.parseCseResults_({ items: [{ title: 'no link here' }] }).length, 0,
    'a result with no link is useless and must be filtered out');
});

test('cseResultLooksLikeProspect_ only accepts a result that actually shares a real name token with the prospect', () => {
  const match = { title: 'Jane Doe Realty | Homes for Sale', snippet: 'Jane Doe has sold...' };
  assert.equal(gas.cseResultLooksLikeProspect_(match, 'Jane Doe'), true);

  const unrelated = { title: 'Best Pizza in Austin', snippet: 'Top 10 pizza joints' };
  assert.equal(gas.cseResultLooksLikeProspect_(unrelated, 'Jane Doe'), false,
    'a search engine returning something with zero relation to the queried name must read as no-match, same as contactNameLooksLikeQuery_ for GHL');

  const partial = { title: 'Doe Family Reunion 2026', snippet: 'Join the Doe family...' };
  assert.equal(gas.cseResultLooksLikeProspect_(partial, 'Jane Doe'), true,
    'sharing just one real (>=3 letter) name token is enough, same threshold as the GHL contact matcher');
});

test('findProspectSocialLinks_ filters out non-matching results and returns only plausible links', () => {
  const originalSearch = gas.googleCseSearch_;
  try {
    gas.googleCseSearch_ = (query) => ({
      status: 200,
      json: {
        items: [
          { title: 'Jane Doe Realty', link: 'https://janedoerealty.com', snippet: 'Jane Doe, agent' },
          { title: 'Completely Unrelated Business', link: 'https://someotherbiz.com', snippet: 'nothing to do with her' }
        ]
      }
    });
    const links = gas.findProspectSocialLinks_('Jane Doe');
    assert.deepEqual(links, ['https://janedoerealty.com']);
  } finally {
    gas.googleCseSearch_ = originalSearch;
  }
});

test('findProspectSocialLinks_ degrades to an empty list, never throws, on a non-200 status or a thrown error', () => {
  const originalSearch = gas.googleCseSearch_;
  try {
    gas.googleCseSearch_ = () => ({ status: 403, json: null, body: 'quota exceeded' });
    // .length, not assert.deepEqual against [] — the empty array is a literal
    // returned from inside the vm sandbox's own findProspectSocialLinks_ body,
    // so it fails deepEqual's cross-realm prototype-identity check.
    assert.equal(gas.findProspectSocialLinks_('Jane Doe').length, 0);

    gas.googleCseSearch_ = () => { throw new Error('network error'); };
    assert.equal(gas.findProspectSocialLinks_('Jane Doe').length, 0,
      'a lookup failure (missing credentials, quota, network) must never block brief generation over a nice-to-have link');
  } finally {
    gas.googleCseSearch_ = originalSearch;
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
