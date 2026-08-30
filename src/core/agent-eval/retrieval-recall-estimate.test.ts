import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mineRepositoryVocabulary, persistRepositoryVocabulary } from '../analyzer/repo-vocabulary.js';
import { estimateVocabularyRecall } from './retrieval-recall-estimate.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('retrieval recall estimate', () => {
  it('labels and measures repository vocabulary recall without claiming an agent benchmark', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'openlore-recall-estimate-'));
    dirs.push(outputDir);
    mkdirSync(join(outputDir, 'vector-index'));
    const stamp = 'a'.repeat(64);
    const vocabulary = mineRepositoryVocabulary([
      { id: 'bind-a', name: 'pmtBinding', signature: 'pmt: Payment', filePath: 'a.ts' },
      { id: 'bind-b', name: 'pmtQueue', signature: 'pmt: Payment', filePath: 'b.ts' },
    ], new Map([['pmt', 3], ['payment', 2]]), stamp);
    await persistRepositoryVocabulary(join(outputDir, 'vector-index'), vocabulary);
    writeFileSync(join(outputDir, 'vector-index-meta.json'), JSON.stringify({
      vocabularyContentStamp: vocabulary.contentStamp,
    }));

    const estimate = estimateVocabularyRecall(outputDir, [
      { id: 'target', name: 'PmtSvc', filePath: 'target.ts', docstring: 'Payment processing service' },
      { id: 'other', name: 'Other', filePath: 'other.ts', docstring: 'Unrelated helper routine' },
    ]);

    expect(estimate.label).toBe('estimate');
    expect(estimate.recallAt).toBe(10);
    expect(estimate.vocabularyAvailable).toBe(true);
    expect(estimate.vocabularyRecall).toBeGreaterThanOrEqual(estimate.baselineRecall);
  });
});
