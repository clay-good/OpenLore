/**
 * Parse-health boundary surfacing (change: add-parse-health-boundary-disclosure).
 * Covers the read side: loading the artifact and building a per-conclusion boundary from the files a
 * result touches. A clean repo (no artifact) must fail open to "no boundary".
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadParseHealthReport, parseHealthBoundary } from './parse-health-boundary.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH } from '../../../constants.js';
import type { ParseHealthReport } from '../../analyzer/parse-health.js';

function repoWith(report: ParseHealthReport | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  if (report) {
    const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    mkdirSync(analysisDir, { recursive: true });
    writeFileSync(join(analysisDir, ARTIFACT_PARSE_HEALTH), JSON.stringify(report));
  }
  return dir;
}

const REPORT: ParseHealthReport = {
  version: 1,
  totalDegradedFiles: 2,
  totalErrorRegions: 3,
  byLanguage: [{ language: 'TypeScript', degradedFiles: 2, errorRegions: 3, parseFailures: 1, encodingFallbacks: 0 }],
  topFiles: [],
  files: [
    { filePath: 'src/a.ts', language: 'TypeScript', errorCount: 2, missingCount: 0, errorLines: [4, 9] },
    { filePath: 'src/b.ts', language: 'TypeScript', errorCount: 0, missingCount: 0, errorLines: [], parseFailed: true },
  ],
};

describe('loadParseHealthReport', () => {
  it('returns null when no artifact exists (clean repo)', async () => {
    expect(await loadParseHealthReport(repoWith(null))).toBeNull();
  });
  it('loads a persisted report', async () => {
    const r = await loadParseHealthReport(repoWith(REPORT));
    expect(r?.totalDegradedFiles).toBe(2);
    expect(r?.files.length).toBe(2);
  });
});

describe('parseHealthBoundary', () => {
  it('is undefined when the report is null (fail open)', () => {
    expect(parseHealthBoundary(null, ['src/a.ts'])).toBeUndefined();
  });
  it('is undefined when no touched file is degraded', () => {
    expect(parseHealthBoundary(REPORT, ['src/clean.ts'])).toBeUndefined();
  });
  it('discloses a lower-bound boundary naming the degraded touched files', () => {
    const note = parseHealthBoundary(REPORT, ['src/a.ts', 'src/b.ts', 'src/clean.ts'])!;
    expect(note).toContain('LOWER BOUND');
    expect(note).toContain('src/a.ts');
    expect(note).toContain('src/b.ts');
    expect(note).toContain('parse failed');
    expect(note).not.toContain('src/clean.ts');
  });
  it('deduplicates repeated touched files', () => {
    const note = parseHealthBoundary(REPORT, ['src/a.ts', 'src/a.ts'])!;
    expect(note).toContain('1 file');
  });
});

describe('boundary text names WHY a file was excluded (change: fix-analyze-native-abort-and-file-cost-budget)', () => {
  const report = (files: ParseHealthReport['files']): ParseHealthReport => ({
    version: 1, totalDegradedFiles: files.length, totalErrorRegions: 0, byLanguage: [], topFiles: files, files,
  });

  it('reports a budget-exceeded file with its elapsed time, not as a generic parse failure', () => {
    // "parse failed" and "we gave up after 20 seconds" call for different actions from the reader,
    // so a conclusion built over the file must say which one happened.
    const text = parseHealthBoundary(report([{
      filePath: 'src/vendor.js', language: 'JavaScript', errorCount: 0, missingCount: 0, errorLines: [],
      parseFailed: true, exclusion: 'budget-exceeded', budgetMs: 20_000,
    }]), ['src/vendor.js']);
    expect(text).toContain('LOWER BOUND');
    expect(text).toContain('abandoned at the per-file parse budget');
    expect(text).toContain('of 20.0s');
    expect(text).not.toContain('parse failed —');
  });

  it('still describes an ordinary parse failure the way it always did', () => {
    const text = parseHealthBoundary(report([{
      filePath: 'src/broken.ts', language: 'TypeScript', errorCount: 0, missingCount: 0, errorLines: [],
      parseFailed: true,
    }]), ['src/broken.ts']);
    expect(text).toContain('parse failed — contributed no symbols');
  });

  it('echoes an exclusion reason it has no label for, rather than rendering "undefined"', () => {
    // The record comes off disk and may have been written by a newer OpenLore. A boundary that
    // reads "src/x.ts (undefined)" would be worse than one naming a reason this build cannot
    // explain.
    const text = parseHealthBoundary(report([{
      filePath: 'src/x.ts', language: 'TypeScript', errorCount: 0, missingCount: 0, errorLines: [],
      exclusion: 'reason-from-the-future' as never,
    }]), ['src/x.ts']);
    expect(text).toContain('reason-from-the-future');
    expect(text).not.toContain('undefined');
  });
});
