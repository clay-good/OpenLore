#!/usr/bin/env node
/**
 * Judge one Windows unit run against the tracked deny-list (issue #434).
 *
 * The `windows-unit` CI job runs the ENTIRE suite on windows-latest — nothing is filtered out — and
 * this script decides whether the result is acceptable, in both directions:
 *
 *   1. a failing file that is NOT on the list is a NEW Windows regression → fail;
 *   2. a listed file with zero failures has been fixed → fail, so the entry must be deleted.
 *
 * Rule 2 is what keeps the list a shrinking backlog rather than a permanent hole. Rule 1 is what
 * makes the job a real gate: without it, the deny-list would be the only thing under test.
 *
 * WHY ONE RUN RATHER THAN TWO. The first version of this ran the suite with the listed files
 * excluded, then re-ran just those files to see if any passed. The two runs disagreed on their very
 * first outing: `git-diff-corpus-materialization.test.ts` passed in the small re-run and failed in
 * the full one. A test's outcome can depend on what else is running beside it — temp directories,
 * worker concurrency, shared fixtures — so two runs in two contexts can each be right and still
 * contradict each other, leaving the job with no consistent verdict. Judging a single run removes
 * the contradiction by construction, and costs about a minute: the full suite takes ~7m against
 * ~6.5m for the filtered one, because the excluded files fail fast far more often than they hang.
 *
 * Usage: node scripts/windows-unit-report.mjs <vitest-json-report>
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LIST_PATH = join(process.cwd(), '.github', 'windows-unit-exclusions.json');
const reportPath = process.argv[2];

function die(message) {
  process.stderr.write(`\nwindows-unit-report: ${message}\n`);
  process.exit(1);
}

if (!reportPath) die('usage: windows-unit-report.mjs <vitest-json-report>');
if (!existsSync(reportPath)) {
  // A missing report means the run died before writing one — never read that as "nothing failed".
  die(`no JSON report at ${reportPath}; the suite did not run to completion.`);
}

const { exclusions } = JSON.parse(readFileSync(LIST_PATH, 'utf-8'));
const excluded = new Map(exclusions.map((entry) => [entry.file, entry]));

const missing = exclusions.filter((entry) => !existsSync(join(process.cwd(), entry.file)));
if (missing.length > 0) {
  die(
    'these entries name files that no longer exist — remove or rename them:\n' +
      missing.map((entry) => `  ${entry.file}`).join('\n'),
  );
}

const report = JSON.parse(readFileSync(reportPath, 'utf-8'));

/** Repo-relative, POSIX-spelled — vitest reports absolute Windows paths. */
function repoRelative(name) {
  const posix = name.replace(/\\/g, '/');
  const at = posix.indexOf('/src/');
  return at === -1 ? posix : posix.slice(at + 1);
}

const failuresByFile = new Map();
for (const suite of report.testResults ?? []) {
  const file = repoRelative(suite.name);
  const failed = (suite.assertionResults ?? []).filter((a) => a.status === 'failed');
  failuresByFile.set(file, (failuresByFile.get(file) ?? 0) + failed.length);
  // A suite that could not even be collected reports no assertions; treat that as a failure rather
  // than as a clean file.
  if (suite.status === 'failed' && failed.length === 0) {
    failuresByFile.set(file, (failuresByFile.get(file) ?? 0) + 1);
  }
}

const regressions = [];
for (const [file, count] of failuresByFile) {
  if (count > 0 && !excluded.has(file)) regressions.push({ file, count });
}

const fixed = exclusions.filter((entry) => (failuresByFile.get(entry.file) ?? 0) === 0);

const total = report.numTotalTests ?? 0;
const failed = report.numFailedTests ?? 0;
const stillFailing = exclusions.length - fixed.length;
const filesRun = failuresByFile.size;
process.stdout.write(
  `windows-unit-report: ${total - failed}/${total} tests passed across ${filesRun} files; ` +
    `${stillFailing} of ${exclusions.length} deny-listed files still failing, ` +
    `${regressions.length} new.\n`,
);

if (regressions.length > 0) {
  die(
    `NEW Windows failure(s) in ${regressions.length} file(s) that are not on the deny-list. ` +
      'Fix them, or add them to .github/windows-unit-exclusions.json with a reason:\n' +
      regressions
        .sort((a, b) => b.count - a.count)
        .map((r) => `  ${r.file}  (${r.count} test${r.count === 1 ? '' : 's'})`)
        .join('\n'),
  );
}

if (fixed.length > 0) {
  die(
    `${fixed.length} deny-listed file(s) now pass on Windows. Delete them from ` +
      '.github/windows-unit-exclusions.json so the list stays a shrinking backlog:\n' +
      fixed.map((entry) => `  ${entry.file}`).join('\n'),
  );
}

process.stdout.write('windows-unit-report: OK — no new failures, and nothing stale on the list.\n');
