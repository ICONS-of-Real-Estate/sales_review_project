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

const gas = loadGasProject(path.join(__dirname, '..'));

test('extractEventIdFromRecordingTitle_ isolates the ID out of the "QC-{id}-{initials}" convention (regression: must not capture the surrounding hyphens/prefix/suffix)', () => {
  const id = 'abcdEFGH12345678ijkl'; // 20 chars — the minimum length the regex requires
  assert.equal(gas.extractEventIdFromRecordingTitle_('QC-' + id + '-BT'), id);
});

test('extractEventIdFromRecordingTitle_ strips a trailing @google.com suffix', () => {
  const id = 'abcdEFGH12345678ijkl';
  assert.equal(gas.extractEventIdFromRecordingTitle_('QC-' + id + '@google.com-BT'), id);
});

test('extractEventIdFromRecordingTitle_ returns null when no ID-shaped token is present', () => {
  assert.equal(gas.extractEventIdFromRecordingTitle_('Discovery Call with Sean'), null);
  assert.equal(gas.extractEventIdFromRecordingTitle_(''), null);
});

test('normalizeEventId_ strips the @google.com suffix and trims whitespace', () => {
  assert.equal(gas.normalizeEventId_('  abc123@google.com  '), 'abc123');
  assert.equal(gas.normalizeEventId_('abc123'), 'abc123');
  assert.equal(gas.normalizeEventId_(''), '');
});

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
    manual_review_recommended: false,
    severity: 2
  };
  assert.equal(gas.isValidJudgeSchema_(good), true);
  assert.equal(gas.isValidJudgeSchema_(Object.assign({}, good, { severity: undefined })), false);
  assert.equal(gas.isValidJudgeSchema_(null), false);
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

test('findTxtTranscriptFile_ picks the txt file out of a recording detail\'s transcription.files[]', () => {
  const detail = { transcription: { files: [{ type: 'srt', download_url: 'a' }, { type: 'txt', download_url: 'b' }] } };
  assert.equal(gas.findTxtTranscriptFile_(detail).download_url, 'b');
  assert.equal(gas.findTxtTranscriptFile_({ transcription: { files: [] } }), null);
  assert.equal(gas.findTxtTranscriptFile_({}), null);
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
