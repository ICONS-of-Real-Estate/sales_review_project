'use strict';

/**
 * Loads the .gs files listed below the way Apps Script actually runs them: all
 * concatenated into one shared global scope (that's why they freely
 * cross-reference each other's functions/vars with no import statements —
 * see the file-header comments in Phase2_CallScoring.gs). Runs the concatenated source inside a Node vm
 * context with the Google Apps Script globals stubbed out, and returns that
 * context so tests can call the functions defined in it directly.
 *
 * Only the PURE helper functions (string/regex parsing, schema checks, the
 * Cohen's-kappa math) are meant to be exercised through this harness — the
 * stub globals below exist only so the files' top-level code (var CONFIG =
 * {...}, function declarations) loads without throwing; they are NOT real
 * implementations, and calling a function that actually reaches Drive/Sheets/
 * Calendar/Mail/UrlFetchApp through them will throw a clear
 * "not implemented in test stub" error rather than silently doing nothing.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAS_FILES = [
  'Phase1_ComplianceCheck.gs',
  'Phase2_CallScoring.gs',
  'Phase3_HandoffBrief.gs',
  'Phase4_InboxSLA.gs',
  'Phase5_WeeklyScorecard.gs',
  'Phase6_TrainingCallReview.gs',
  'Phase7_DailySelfPractice.gs',
  'Phase8_ReplyTracker.gs',
  'Phase9_GhlSync.gs',
  'Phase10_ConversionFunnel.gs',
  'Phase11_BensPodcastSync.gs',
  'Phase12_GhlNoteSync.gs',
  'Phase13_LeadReconciliation.gs'
];

function stubApi(name) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      return function () {
        throw new Error('Test stub: ' + name + '.' + String(prop) + '() is not implemented — ' +
          'this harness only exercises pure logic, not real Apps Script services.');
      };
    }
  });
}

function loadGasProject(repoRoot) {
  const source = GAS_FILES
    .map((f) => fs.readFileSync(path.join(repoRoot, f), 'utf8'))
    .join('\n;\n');

  const sandbox = {
    Logger: { log: function () {} },
    Utilities: stubApi('Utilities'),
    SpreadsheetApp: stubApi('SpreadsheetApp'),
    DriveApp: stubApi('DriveApp'),
    CalendarApp: stubApi('CalendarApp'),
    MailApp: stubApi('MailApp'),
    GmailApp: stubApi('GmailApp'),
    PropertiesService: stubApi('PropertiesService'),
    LockService: stubApi('LockService'),
    ScriptApp: stubApi('ScriptApp'),
    DocumentApp: stubApi('DocumentApp'),
    UrlFetchApp: stubApi('UrlFetchApp'),
    Session: stubApi('Session'),
    MimeType: { GOOGLE_DOCS: 'application/vnd.google-apps.document' },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'gas-project-concat.js' });
  // vm.createContext gives the sandbox its OWN realm, so built-ins like Date
  // aren't the same constructor as the outer Node process's — an
  // `instanceof Date` check inside a loaded function would silently fail
  // against a `new Date()` built in the caller's realm. Exposing the
  // sandbox's own Date lets tests construct values that satisfy `instanceof`
  // checks made by code running inside this same context.
  vm.runInContext('this.Date = Date;', sandbox);
  return sandbox;
}

module.exports = { loadGasProject };
