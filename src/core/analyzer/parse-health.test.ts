/**
 * Parse-health disclosure (change: add-parse-health-boundary-disclosure).
 *
 * Two layers of coverage:
 *   1. Unit — the pure module (`tallyParseHealth`, `isLossyUtf8`, `buildParseHealthReport`)
 *      over hand-built node objects, so the tally logic is tested without a grammar.
 *   2. Build — the real `CallGraphBuilder` over source with a deliberate syntax error, proving the
 *      signal fires end-to-end AND that a clean file produces no record (clean repos pay zero).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tallyParseHealth,
  isLossyUtf8,
  buildParseHealthReport,
  isDegraded,
  compactParseHealthSummary,
  describeExclusions,
  totalExcluded,
  EXCLUSION_REASON_LABEL,
  type ParseHealthNode,
  type FileParseHealth,
  type FileExclusionReason,
} from './parse-health.js';
import { CallGraphBuilder } from './call-graph.js';

/** Build a minimal node object (defaults: clean, no error). */
function node(partial: Partial<ParseHealthNode> & { type: string }): ParseHealthNode {
  return { startPosition: { row: 0 }, children: [], ...partial };
}

describe('tallyParseHealth (unit)', () => {
  it('returns undefined for a clean tree (fast path, zero cost)', () => {
    const root = node({ type: 'program', hasError: false, children: [node({ type: 'function' })] });
    expect(tallyParseHealth('TypeScript', root, 'a.ts')).toBeUndefined();
  });

  it('counts ERROR nodes and records their 1-based start lines', () => {
    const root = node({
      type: 'program',
      hasError: true,
      children: [
        node({ type: 'function', startPosition: { row: 0 } }),
        node({ type: 'ERROR', startPosition: { row: 4 } }),
      ],
    });
    const h = tallyParseHealth('TypeScript', root, 'a.ts')!;
    expect(h.errorCount).toBe(1);
    expect(h.missingCount).toBe(0);
    expect(h.errorLines).toEqual([5]); // row 4 → line 5
    expect(h.filePath).toBe('a.ts');
  });

  it('counts MISSING nodes (isMissing as property OR method)', () => {
    const root = node({
      type: 'program',
      hasError: true,
      children: [
        node({ type: 'identifier', isMissing: true, startPosition: { row: 1 } }),
        node({ type: ';', isMissing: () => true, startPosition: { row: 2 } }),
      ],
    });
    const h = tallyParseHealth('Python', root, 'b.py')!;
    expect(h.missingCount).toBe(2);
    expect(h.errorLines).toEqual([2, 3]);
  });

  it('bounds the error-line list and discloses truncation', () => {
    const children = Array.from({ length: 40 }, (_, i) => node({ type: 'ERROR', startPosition: { row: i } }));
    const root = node({ type: 'program', hasError: true, children });
    const h = tallyParseHealth('Go', root, 'c.go')!;
    expect(h.errorCount).toBe(40);
    expect(h.errorLines.length).toBe(25); // PARSE_HEALTH_LINE_CAP
    expect(h.truncated).toBe(true);
  });

  it('drops a spurious hasError=true with no confirmed ERROR/MISSING node (sound lower bound)', () => {
    // Some grammars flag hasError on well-formed input; over-reporting would cry wolf, so a signal
    // with no actual error node is dropped, not fabricated.
    const root = node({ type: 'program', hasError: true, startPosition: { row: 7 }, children: [] });
    expect(tallyParseHealth('Ruby', root, 'd.rb')).toBeUndefined();
  });
});

describe('isLossyUtf8', () => {
  it('is false for valid UTF-8, including a legitimately-present U+FFFD (EF BF BD)', () => {
    expect(isLossyUtf8(new TextEncoder().encode('const x = 1;'))).toBe(false);
    // A source that legitimately CONTAINS U+FFFD encodes to valid UTF-8 — not a lossy decode.
    expect(isLossyUtf8(new TextEncoder().encode('const x = "�";'))).toBe(false);
  });
  it('is true for genuinely invalid UTF-8 byte sequences', () => {
    expect(isLossyUtf8(new Uint8Array([0x61, 0xff, 0xfe, 0x62]))).toBe(true); // lone 0xFF/0xFE
    expect(isLossyUtf8(new Uint8Array([0xc0, 0x80]))).toBe(true); // overlong encoding
  });
});

describe('buildParseHealthReport', () => {
  it('returns undefined when nothing is degraded', () => {
    expect(buildParseHealthReport([])).toBeUndefined();
    const clean: FileParseHealth = { filePath: 'a.ts', language: 'TypeScript', errorCount: 0, missingCount: 0, errorLines: [] };
    expect(isDegraded(clean)).toBe(false);
    expect(buildParseHealthReport([clean])).toBeUndefined();
  });

  it('rolls up per-language counts, sorts top files, and keeps every record', () => {
    const records: FileParseHealth[] = [
      { filePath: 'a.ts', language: 'TypeScript', errorCount: 3, missingCount: 0, errorLines: [1] },
      { filePath: 'b.ts', language: 'TypeScript', errorCount: 1, missingCount: 0, errorLines: [2] },
      { filePath: 'c.py', language: 'Python', errorCount: 0, missingCount: 0, errorLines: [], parseFailed: true },
      { filePath: 'd.go', language: 'Go', errorCount: 0, missingCount: 0, errorLines: [], encodingFallback: true },
    ];
    const report = buildParseHealthReport(records)!;
    expect(report.totalDegradedFiles).toBe(4);
    expect(report.totalErrorRegions).toBe(4);
    const ts = report.byLanguage.find(l => l.language === 'TypeScript')!;
    expect(ts.degradedFiles).toBe(2);
    expect(ts.errorRegions).toBe(4);
    expect(report.byLanguage.find(l => l.language === 'Python')!.parseFailures).toBe(1);
    expect(report.byLanguage.find(l => l.language === 'Go')!.encodingFallbacks).toBe(1);
    // Worst offender (a.ts, 3 regions) ranks first.
    expect(report.topFiles[0].filePath).toBe('a.ts');
    expect(report.files.length).toBe(4);
    expect(compactParseHealthSummary(report).length).toBe(3); // one line per language
  });
});

describe('CallGraphBuilder parse-health capture (build integration)', () => {
  it('records a parse-health entry for a file with a syntax error, and still extracts prior symbols', async () => {
    // `good` is a well-formed function; the trailing `function broken(` is unterminated → ERROR.
    const content = `function good() { return 1; }\nfunction broken( {\n`;
    const r = await new CallGraphBuilder().build([{ path: 'x.ts', content, language: 'TypeScript' }]);
    const names = [...r.nodes.values()].map(n => n.name);
    expect(names, 'the well-formed function before the error is still extracted').toContain('good');
    const health = r.parseHealthByFile?.get('x.ts');
    expect(health, 'the syntax error is recorded as a parse-health signal').toBeDefined();
    expect(isDegraded(health!)).toBe(true);
    expect(health!.errorCount + health!.missingCount).toBeGreaterThan(0);
  });

  it('produces NO parse-health record for a clean file (clean repos pay zero)', async () => {
    const content = `function a() { return b(); }\nfunction b() { return 1; }\n`;
    const r = await new CallGraphBuilder().build([{ path: 'y.ts', content, language: 'TypeScript' }]);
    expect(r.parseHealthByFile?.get('y.ts')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Exclusion reasons (change: fix-analyze-native-abort-and-file-cost-budget)
// ---------------------------------------------------------------------------

describe('exclusion reasons', () => {
  const excluded = (path: string, exclusion: FileExclusionReason, budgetMs?: number): FileParseHealth => ({
    filePath: path, language: 'TypeScript', errorCount: 0, missingCount: 0, errorLines: [],
    exclusion, ...(budgetMs !== undefined ? { budgetMs } : {}),
  });

  it('counts exclusions per reason in the rolled-up report', () => {
    const report = buildParseHealthReport([
      excluded('a.ts', 'budget-exceeded', 20_000),
      excluded('b.ts', 'budget-exceeded', 21_000),
      excluded('c.ts', 'parse-failure'),
    ]);
    expect(report?.excludedByReason).toEqual({ 'budget-exceeded': 2, 'parse-failure': 1 });
    expect(totalExcluded(report)).toBe(3);
  });

  it('omits the tally entirely when nothing was excluded, so an ordinary report is unchanged', () => {
    // A repo whose only signal is error regions must not grow an empty tally — the artifact stays
    // byte-identical to what it was before this change.
    const report = buildParseHealthReport([
      { filePath: 'a.ts', language: 'TypeScript', errorCount: 2, missingCount: 0, errorLines: [3, 9] },
    ]);
    expect(report).toBeDefined();
    expect('excludedByReason' in report!).toBe(false);
    expect(totalExcluded(report)).toBe(0);
    expect(describeExclusions(report)).toBeUndefined();
  });

  it('describes exclusions in a fixed reason order so the line is deterministic', () => {
    const report = buildParseHealthReport([
      excluded('c.ts', 'size-cap'),
      excluded('a.ts', 'budget-exceeded', 20_000),
      excluded('b.ts', 'parse-failure'),
    ]);
    expect(describeExclusions(report)).toBe('3 files excluded (1 budget-exceeded, 1 parse-failure, 1 size-cap)');
  });

  it('treats an excluded file as degraded even with no error regions', () => {
    // A budget-exceeded file has zero ERROR nodes — the parse never got far enough to produce any.
    // If exclusion did not count as degradation it would vanish from the report entirely.
    expect(isDegraded(excluded('a.ts', 'budget-exceeded', 20_000))).toBe(true);
  });

  it.each(['parse-failure', 'budget-exceeded', 'size-cap'] as FileExclusionReason[])(
    'has a human label for %s, so no surface has to invent its own wording',
    (reason) => expect(EXCLUSION_REASON_LABEL[reason]).toBeTruthy(),
  );

  it('never reports a worker fault as a file-level exclusion', () => {
    // A worker fault degrades the LANE: the pool hands the file to the main thread, which is the
    // reference implementation, so the file is not excluded at all. Recording it here would blame
    // the source for a defect in the thread reading it.
    expect(Object.keys(EXCLUSION_REASON_LABEL)).not.toContain('worker-fault');
  });
});

describe('analyze and doctor cannot disagree about exclusions', () => {
  // The requirement is that any surface reporting extraction health reads the SAME record. These
  // are structural guards: the previous shape had `doctor` judging independently, which let it
  // report a clean bill of health for a repository whose analysis had excluded files.
  const src = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8');

  it('doctor reads the shared record through the shared helper', () => {
    const doctor = src('cli/commands/doctor.ts');
    expect(doctor).toContain('describeExclusions');
  });

  it('analyze reports the same exclusions from the same helper', () => {
    expect(src('cli/commands/analyze.ts')).toContain('describeExclusions');
  });

  it('analyze reports skipped files broken down by reason, not as a bare count', () => {
    expect(src('cli/commands/analyze.ts')).toContain('skippedReasons');
  });
});
