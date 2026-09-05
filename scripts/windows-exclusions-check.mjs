#!/usr/bin/env node
/**
 * Keep `.github/windows-unit-exclusions.json` honest (issue #434).
 *
 * The Windows unit job skips the files named there. Without this check, a file fixed as a side
 * effect of some other change would sit on the list forever, and the list would quietly become a
 * permanent hole rather than a shrinking backlog — the exact failure mode that let 480 of 481 test
 * files go unrun on Windows in the first place.
 *
 * So: re-run EXACTLY the excluded files and fail if any of them now passes in full. The fix is to
 * delete that line from the list, which is the point.
 *
 * It also fails when the list names a file that no longer exists, so a renamed or deleted test
 * cannot leave a stale entry behind.
 *
 * Runs only on Windows; on any other platform it exits 0 with a note, because the whole list is
 * about Windows-only behaviour and every one of these files already passes elsewhere.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LIST_PATH = join(process.cwd(), '.github', 'windows-unit-exclusions.json');
const RESULTS = join(process.cwd(), 'windows-exclusion-recheck.json');

function fail(message) {
  process.stderr.write(`windows-exclusions-check: ${message}\n`);
  process.exit(1);
}

const { exclusions } = JSON.parse(readFileSync(LIST_PATH, 'utf-8'));
if (!Array.isArray(exclusions) || exclusions.length === 0) {
  process.stdout.write('windows-exclusions-check: list is empty — nothing to re-check.\n');
  process.exit(0);
}

const missing = exclusions.filter((entry) => !existsSync(join(process.cwd(), entry.file)));
if (missing.length > 0) {
  fail(
    `these entries name files that do not exist — remove or rename them:\n` +
      missing.map((entry) => `  ${entry.file}`).join('\n'),
  );
}

if (process.platform !== 'win32') {
  process.stdout.write(
    `windows-exclusions-check: ${exclusions.length} entries, all present. ` +
      'Skipping the re-run: this list is about Windows-only failures.\n',
  );
  process.exit(0);
}

rmSync(RESULTS, { force: true });
// The excluded files fail by definition, so a non-zero exit is expected and not read as an error;
// the JSON report is the signal. `--exclude` is emptied so the deny-list cannot filter out the very
// files being re-checked.
spawnSync(
  process.execPath,
  [
    join('node_modules', 'vitest', 'vitest.mjs'),
    'run',
    ...exclusions.map((entry) => entry.file),
    '--exclude', '',
    '--reporter=json',
    `--outputFile=${RESULTS}`,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true },
);

if (!existsSync(RESULTS)) {
  fail('the re-run produced no JSON report; treat as a failure rather than as "nothing to do".');
}

const report = JSON.parse(readFileSync(RESULTS, 'utf-8'));
const failedByFile = new Map();
for (const suite of report.testResults ?? []) {
  const file = suite.name.replace(/\\/g, '/').replace(/^.*?\/(src\/.*)$/, '$1');
  const failed = (suite.assertionResults ?? []).filter((a) => a.status === 'failed').length;
  failedByFile.set(file, (failedByFile.get(file) ?? 0) + failed);
}

const nowPassing = exclusions.filter((entry) => failedByFile.get(entry.file) === 0);

if (nowPassing.length > 0) {
  fail(
    `${nowPassing.length} excluded file(s) now pass on Windows. Delete them from ` +
      `.github/windows-unit-exclusions.json so the suite actually covers them:\n` +
      nowPassing.map((entry) => `  ${entry.file}`).join('\n'),
  );
}

process.stdout.write(
  `windows-exclusions-check: OK — all ${exclusions.length} excluded files still fail on Windows.\n`,
);
