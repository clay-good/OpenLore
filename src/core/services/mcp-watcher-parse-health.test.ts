/**
 * The watcher's parse-health lane, as a SECOND PRODUCER of the exclusion vocabulary
 * (change: fix-analyze-native-abort-and-file-cost-budget).
 *
 * `parse-health.json` is read by `doctor`, by `analyze`'s exclusion summary and by every
 * conclusion tool's boundary disclosure — and it has two writers: the full build, and this
 * incremental lane, which splices a changed file's record into the existing artifact on every
 * save. If the two disagree about how to record the same file, the record stops being a single
 * source of truth and the surfaces that read it start contradicting each other again — which is
 * the whole failure the `EveryExcludedFileIsRecordedWithAReason` requirement exists to close.
 *
 * So these tests pin the watcher lane against the same vocabulary the full build uses. Before this
 * change, this lane recorded a bare `parseFailed: true` with no reason at all, and there was no
 * test over it whatsoever.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpWatcher } from './mcp-watcher.js';
import {
  ARTIFACT_PARSE_HEALTH,
  PARSE_BUDGET_ENV,
  PER_FILE_PARSE_BUDGET_MS,
  MAX_HTML_INLINE_SCRIPT_CHARS,
} from '../../constants.js';
import type { ParseHealthReport } from '../analyzer/parse-health.js';

/** The payload that reproduced the abort: a 300 KB unterminated block comment. */
const HOSTILE_TS = '/*x'.repeat(100_000);

afterEach(() => { delete process.env[PARSE_BUDGET_ENV]; });

/** A watcher over a throwaway root, with its analysis dir created. */
function watcherIn(): { watcher: McpWatcher; outputPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'wph-'));
  const outputPath = join(root, '.openlore', 'analysis');
  mkdirSync(outputPath, { recursive: true });
  return { watcher: new McpWatcher({ rootPath: root, outputPath }), outputPath };
}

/** Drive the private incremental lane directly — it is the unit under test. */
async function spliceParseHealth(
  watcher: McpWatcher,
  changed: Array<{ rel: string; content: string }>,
  deleted: string[] = [],
): Promise<void> {
  await (watcher as unknown as {
    updateParseHealth(c: Array<{ rel: string; content: string }>, d?: string[]): Promise<void>;
  }).updateParseHealth(changed, deleted);
}

function readReport(outputPath: string): ParseHealthReport | null {
  const p = join(outputPath, ARTIFACT_PARSE_HEALTH);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as ParseHealthReport) : null;
}

describe('watcher parse-health lane — the exclusion vocabulary matches the full build', () => {
  it('records a budget overrun as budget-exceeded, not as a bare parse failure', async () => {
    process.env[PARSE_BUDGET_ENV] = '400';
    const { watcher, outputPath } = watcherIn();

    await spliceParseHealth(watcher, [{ rel: 'src/hostile.ts', content: HOSTILE_TS }]);

    const report = readReport(outputPath);
    const rec = report?.files.find(f => f.filePath === 'src/hostile.ts');
    expect(rec, 'the changed file is spliced into the artifact').toBeDefined();
    expect(rec!.exclusion).toBe('budget-exceeded');
    expect(rec!.parseFailed).toBe(true);
    // The BUDGET, never the measured elapsed time — this artifact is persisted and must be
    // byte-identical across re-analyses of a fixed repository state.
    expect(rec!.budgetMs).toBe(400);
    expect(report!.excludedByReason).toEqual({ 'budget-exceeded': 1 });
  }, 60_000);

  it('still records an ordinary syntax error as a degraded file, not an exclusion', async () => {
    // The classifier must not launder every failure into "budget-exceeded". A file the grammar
    // merely struggled with is degraded, and a degraded file is not an excluded one.
    const { watcher, outputPath } = watcherIn();

    await spliceParseHealth(watcher, [
      { rel: 'src/broken.ts', content: 'function good() { return 1; }\nfunction broken( {\n' },
    ]);

    const rec = readReport(outputPath)?.files.find(f => f.filePath === 'src/broken.ts');
    expect(rec).toBeDefined();
    expect(rec!.exclusion).toBeUndefined();
    expect(rec!.errorCount + rec!.missingCount).toBeGreaterThan(0);
    expect(readReport(outputPath)!.excludedByReason).toBeUndefined();
  }, 60_000);

  it('writes NO artifact for a clean file — a clean repo still pays zero', async () => {
    const { watcher, outputPath } = watcherIn();
    await spliceParseHealth(watcher, [
      { rel: 'src/ok.ts', content: 'export function a(): void { b(); }\nfunction b(): void {}\n' },
    ]);
    expect(readReport(outputPath)).toBeNull();
  }, 60_000);

  it('drops the exclusion when the offending file is repaired', async () => {
    // The lane must be able to CLEAR a record, not only add one — otherwise a repository stays
    // permanently marked as having excluded a file it no longer contains.
    process.env[PARSE_BUDGET_ENV] = '400';
    const { watcher, outputPath } = watcherIn();
    await spliceParseHealth(watcher, [{ rel: 'src/hostile.ts', content: HOSTILE_TS }]);
    expect(readReport(outputPath)?.excludedByReason).toEqual({ 'budget-exceeded': 1 });

    delete process.env[PARSE_BUDGET_ENV];
    await spliceParseHealth(watcher, [
      { rel: 'src/hostile.ts', content: 'export function a(): void { b(); }\nfunction b(): void {}\n' },
    ]);
    expect(readReport(outputPath), 'the last degraded file was repaired — artifact removed').toBeNull();
  }, 60_000);

  it('preserves a whole-language grammar boundary while rebuilding file-level health', async () => {
    const { watcher, outputPath } = watcherIn();
    const existing: ParseHealthReport = {
      version: 1,
      totalDegradedFiles: 1,
      totalErrorRegions: 0,
      byLanguage: [{
        language: 'TypeScript', degradedFiles: 1, errorRegions: 0, parseFailures: 1,
        encodingFallbacks: 0,
      }],
      topFiles: [],
      files: [{
        filePath: 'src/repaired.ts', language: 'TypeScript', errorCount: 0, missingCount: 0,
        errorLines: [], parseFailed: true, exclusion: 'parse-failure',
      }],
      grammarUnavailable: [{
        language: 'Python', fileCount: 5, reason: 'load-failure', detail: 'missing grammar',
      }],
    };
    writeFileSync(join(outputPath, ARTIFACT_PARSE_HEALTH), JSON.stringify(existing));

    await spliceParseHealth(watcher, [{
      rel: 'src/repaired.ts', content: 'export function repaired(): number { return 1; }',
    }]);

    const report = readReport(outputPath);
    expect(report?.files).toEqual([]);
    expect(report?.grammarUnavailable).toEqual(existing.grammarUnavailable);
  }, 60_000);


  it('does NOT erase a size-cap exclusion when the oversized file is touched', async () => {
    // The watcher re-derives a changed file's record. An oversized HTML file is excluded BEFORE
    // extraction, so `extractFileParseHealth` returns nothing for it — and the lane used to read
    // that as "now clean" and delete the record, leaving `doctor` blessing a repository the next
    // `analyze` excludes a file from again. The watcher applies the same bound instead.
    const { watcher, outputPath } = watcherIn();
    const huge = `<html><body>${'<p>x</p>'.repeat(200_000)}</body></html>`;
    expect(huge.length).toBeGreaterThan(MAX_HTML_INLINE_SCRIPT_CHARS);

    await spliceParseHealth(watcher, [{ rel: 'src/huge.html', content: huge }]);
    const rec = readReport(outputPath)?.files.find(f => f.filePath === 'src/huge.html');
    expect(rec?.exclusion).toBe('size-cap');
    expect(readReport(outputPath)!.excludedByReason).toEqual({ 'size-cap': 1 });
  }, 60_000);

  it('clears the size-cap once the file actually shrinks below the bound', async () => {
    // The other direction: the bound is re-evaluated, not merely remembered, so a genuinely
    // repaired file stops being reported.
    const { watcher, outputPath } = watcherIn();
    const huge = `<html><body>${'<p>x</p>'.repeat(200_000)}</body></html>`;
    await spliceParseHealth(watcher, [{ rel: 'src/huge.html', content: huge }]);
    expect(readReport(outputPath)?.excludedByReason).toEqual({ 'size-cap': 1 });

    await spliceParseHealth(watcher, [{ rel: 'src/huge.html', content: '<html><body>ok</body></html>' }]);
    expect(readReport(outputPath)).toBeNull();
  }, 60_000);

  it('removes a container-only artifact when the final SFC is deleted', async () => {
    const { watcher, outputPath } = watcherIn();
    await spliceParseHealth(watcher, [{
      rel: 'src/App.vue',
      content: '<script>function save() {}</script>',
    }]);
    expect(readReport(outputPath)?.scriptContainers?.[0]).toMatchObject({
      format: 'Vue', fileCount: 1, scriptBlockCount: 1,
    });

    await spliceParseHealth(watcher, [], ['src/App.vue']);
    expect(readReport(outputPath)).toBeNull();
  });

  it('CONTROL: an ordinary file is unaffected by the default budget', async () => {
    // Guards the direction that would be worst: a bound tight enough to start excluding real
    // source. The default is 20 s; nothing ordinary comes close.
    expect(PER_FILE_PARSE_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    const { watcher, outputPath } = watcherIn();
    const big = Array.from(
      { length: 4_000 },
      (_, i) => `export function fn${i}(): number { return helper${i}(); }\nfunction helper${i}(): number { return ${i}; }`,
    ).join('\n');
    await spliceParseHealth(watcher, [{ rel: 'src/generated.ts', content: big }]);
    expect(readReport(outputPath)).toBeNull();
  }, 60_000);
});
