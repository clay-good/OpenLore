import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAnalysisData } from './generate.js';
import { loadAnalysis as loadCliAnalysis } from '../cli/commands/generate.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';

describe('generation analysis handoff', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  async function publishedAnalysis(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'openlore-generate-analysis-'));
    roots.push(root);
    await Promise.all([
      writeFile(join(root, 'repo-structure.json'), JSON.stringify({ statistics: { analyzedFiles: 1 }, domains: [] })),
      writeFile(join(root, 'llm-context.json'), JSON.stringify({
        phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
        phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
        phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
      })),
      writeFile(join(root, 'dependency-graph.json'), JSON.stringify({ nodes: [], edges: [], statistics: {} })),
      writeFile(join(root, 'fingerprint.json'), '{}'),
      writeFile(join(root, 'refactor-priorities.json'), JSON.stringify({ priorities: [{ symbol: 'hotspot' }] })),
    ]);
    await publishGeneration(root, [...REQUIRED_ANALYSIS_ARTIFACTS]);
    return root;
  }

  it.each([
    ['missing', async (path: string) => rm(path)],
    ['corrupt', async (path: string) => writeFile(path, '{not-json')],
  ] as const)('accepts an honestly %s dependency graph while validating the remaining generation', async (_state, damage) => {
    const analysisPath = await publishedAnalysis();
    await damage(join(analysisPath, 'dependency-graph.json'));

    const result = await loadAnalysisData(analysisPath);
    const cliResult = await loadCliAnalysis(analysisPath);

    expect(result.depGraph).toBeUndefined();
    expect(result.repoStructure.statistics.analyzedFiles).toBe(1);
    expect(result.generationCompatibility).toBe('manifest');
    expect(result.refactorReport).toEqual({ priorities: [{ symbol: 'hotspot' }] });
    expect(cliResult.state).toBe('ok');
    if (cliResult.state !== 'ok') throw new Error('expected CLI analysis handoff');
    expect(cliResult.data.depGraph).toBeUndefined();
    expect(cliResult.data.refactorReport).toEqual(result.refactorReport);
    expect(cliResult.data.generationCompatibility).toBe(result.generationCompatibility);
  });
});
