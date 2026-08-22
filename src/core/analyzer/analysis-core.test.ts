import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeProjectFingerprint } from '../services/mcp-handlers/utils.js';
import { isAnalysisCacheFresh, mergeAnalysisPatterns, type AnalysisReporter } from './analysis-core.js';

describe('shared analysis core', () => {
  it('merges configured and caller patterns without duplicates', () => {
    expect(mergeAnalysisPatterns(
      { includePatterns: ['**/*.graphql'], excludePatterns: ['vendor/**'] },
      ['**/*.prisma', '**/*.graphql'],
      ['generated/**', 'vendor/**'],
    )).toEqual({
      includePatterns: ['**/*.graphql', '**/*.prisma'],
      excludePatterns: ['vendor/**', 'generated/**'],
    });
  });

  it('allows a silent reporter so the core never needs console output', () => {
    const report = vi.fn();
    const reporter: AnalysisReporter = { report };
    reporter.report({ stage: 'mapping', status: 'start', detail: 'Scanning directory structure' });
    expect(report).toHaveBeenCalledOnce();
  });

  it('checks the fingerprint in the requested custom output directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-freshness-'));
    const output = join(root, '.openlore', 'custom-analysis');
    await mkdir(output, { recursive: true });
    await writeFile(join(root, 'source.ts'), 'export const value = 1;');
    const hash = await computeProjectFingerprint(root);
    await writeFile(join(output, 'fingerprint.json'), JSON.stringify({ hash }));
    expect(await isAnalysisCacheFresh(root, output)).toBe(true);
    await writeFile(join(root, 'source.ts'), 'export const changedValue = 2;');
    expect(await isAnalysisCacheFresh(root, output)).toBe(false);
  });

  it('keeps the final source fingerprint fence inside the publication lock', async () => {
    const source = await readFile(new URL('./analysis-core.ts', import.meta.url), 'utf-8');
    const lockStart = source.indexOf('await withAnalysisLock(outputPath');
    const finalFence = source.indexOf('await computeProjectFingerprint(rootPath,', lockStart);
    const publish = source.indexOf('await publishGeneration(outputPath', lockStart);
    expect(lockStart).toBeGreaterThan(-1);
    expect(finalFence).toBeGreaterThan(lockStart);
    expect(publish).toBeGreaterThan(finalFence);
  });
});
