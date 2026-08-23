import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FunctionNode } from '../../analyzer/call-graph.js';
import type { FileSignatureMap } from '../../analyzer/signature-extractor.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../analyzer/vector-index.js';
import { SpecVectorIndex } from '../../analyzer/spec-vector-index.js';
import { TextLineIndex } from '../../analyzer/text-line-index.js';
import { handleExplainRetrievalMiss } from './retrieval-miss.js';

function node(id: string, name: string, filePath: string, language = 'TypeScript'): FunctionNode {
  return {
    id, name, filePath, language, isAsync: false, startIndex: 0, endIndex: 0,
    fanIn: 0, fanOut: 0,
  };
}

describe('handleExplainRetrievalMiss', () => {
  let root: string;
  let outputDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-retrieval-miss-'));
    outputDir = join(root, '.openlore', 'analysis');
    await mkdir(outputDir, { recursive: true });
    _resetVectorIndexCachesForTesting();
    const nodes = [
      node('src/a.ts::shared', 'shared', 'src/a.ts'),
      node('src/b.ts::shared', 'shared', 'src/b.ts'),
      node('src/c.py::pythonOnly', 'pythonOnly', 'src/c.py', 'Python'),
      node('src/d.ts::fourthTarget', 'fourthTarget', 'src/d.ts'),
    ];
    const signatures: FileSignatureMap[] = nodes.map((n) => ({
      path: n.filePath,
      language: n.language,
      entries: [{ kind: 'function', name: n.name, signature: `function ${n.name}()`, docstring: 'shared retrieval fixture' }],
    }));
    await VectorIndex.build(outputDir, nodes, signatures, new Set(), new Set(), null);
  });

  it('refuses a missing target without enumerating misses', async () => {
    const result = await handleExplainRetrievalMiss(root, {
      query: 'shared', surface: 'code', target: { kind: 'symbol', value: '' },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ usageError: true });
    expect(result).not.toHaveProperty('results');
  });

  it('returns bounded ambiguity candidates instead of guessing', async () => {
    const result = await handleExplainRetrievalMiss(root, {
      query: 'shared', surface: 'code', target: { kind: 'symbol', value: 'shared' },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ usageError: true });
    expect(result.candidates).toEqual(['src/a.ts::shared', 'src/b.ts::shared']);
  });

  it.each([
    ['not-indexed', { kind: 'symbol', value: 'missing', filePath: 'src/missing.ts' }],
    ['capability-unsupported-for-language', { kind: 'file', value: 'src/legacy.hs' }],
    ['filtered-out', { kind: 'symbol', value: 'pythonOnly', filePath: 'src/c.py' }],
    ['no-term-matched', { kind: 'symbol', value: 'shared', filePath: 'src/a.ts' }],
  ] as const)('distinguishes %s', async (cause, target) => {
    const result = await handleExplainRetrievalMiss(root, {
      query: cause === 'no-term-matched' ? 'zzzz-no-hit' : 'shared',
      surface: 'code',
      target,
      ...(cause === 'filtered-out' ? { language: 'TypeScript' } : {}),
    }) as Record<string, unknown>;
    expect(result.cause).toBe(cause);
  });

  it.each([
    { language: 'TypeScript' },
    { minFanIn: 1 },
  ])('keeps not-indexed precedence for a missing symbol with filters (%o)', async (filter) => {
    const searchSpy = vi.spyOn(VectorIndex, 'search');
    const result = await handleExplainRetrievalMiss(root, {
      query: 'shared', surface: 'code',
      target: { kind: 'symbol', value: 'missing', filePath: 'src/missing.ts' },
      ...filter,
    });
    expect(result).toMatchObject({ cause: 'not-indexed' });
    expect(searchSpy).not.toHaveBeenCalled();
    searchSpy.mockRestore();
  });

  it('reports 1-based outranked rank and the clamped cutoff', async () => {
    const result = await handleExplainRetrievalMiss(root, {
      query: 'shared', surface: 'code', limit: 1,
      target: { kind: 'symbol', value: 'shared', filePath: 'src/b.ts' },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ cause: 'outranked', rank: 2, cutoff: 1 });
  });

  it('reports omission by the ordinary bounded candidate window', async () => {
    const result = await handleExplainRetrievalMiss(root, {
      query: 'shared', surface: 'code', limit: 1,
      target: { kind: 'symbol', value: 'fourthTarget', filePath: 'src/d.ts' },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ cause: 'budget-truncated', budget: 'candidate-window' });
    expect(result).not.toHaveProperty('rank');
  });

  it('returns evidence when the named target surfaced and is deterministic', async () => {
    const input = {
      query: 'shared', surface: 'code' as const,
      target: { kind: 'symbol' as const, value: 'shared', filePath: 'src/a.ts' },
    };
    const first = await handleExplainRetrievalMiss(root, input);
    const second = await handleExplainRetrievalMiss(root, input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ surfaced: true, rank: 1, matchEvidence: { field: 'symbol', tier: 1 } });
  });

  it('traces the literal-text fallback for a named file when symbol search is empty', async () => {
    await TextLineIndex.build(outputDir, [{
      filePath: 'docs/banner.html',
      content: '<div>uniquebannerphrase</div>',
    }]);
    const result = await handleExplainRetrievalMiss(root, {
      query: 'uniquebannerphrase',
      surface: 'code',
      target: { kind: 'file', value: 'docs/banner.html' },
    });
    expect(result).toMatchObject({
      surfaced: true,
      rank: 1,
      matchEvidence: { field: 'body', terms: ['uniquebannerphrase'], tier: 1 },
    });
  });

  it('validates surface-specific inputs before consulting index state', async () => {
    const noIndexRoot = await mkdtemp(join(tmpdir(), 'openlore-retrieval-no-index-'));
    await expect(handleExplainRetrievalMiss(noIndexRoot, {
      query: 'legacy', surface: 'code', target: { kind: 'file', value: 'src/legacy.hs' },
    })).resolves.toMatchObject({ cause: 'capability-unsupported-for-language' });
    await expect(handleExplainRetrievalMiss(noIndexRoot, {
      query: 'auth', surface: 'code', target: { kind: 'requirement', value: 'auth.login' },
    })).resolves.toMatchObject({ usageError: true });
  });

  it('resolves a canonical spec requirement id and reports its scored prose field', async () => {
    const specsDir = join(root, 'openspec', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), `# Auth Specification\n\n## Requirements\n\n### Requirement: Login\n\nThe system SHALL authenticate credentials.\n\n#### Scenario: Login\n- **GIVEN** credentials\n- **WHEN** login runs\n- **THEN** access is returned\n`);
    await SpecVectorIndex.build(outputDir, join(root, 'openspec', 'specs'), null);
    const result = await handleExplainRetrievalMiss(root, {
      query: 'login', surface: 'spec', target: { kind: 'requirement', value: 'auth.login' },
    });
    expect(result).toMatchObject({ surfaced: true, rank: 1, matchEvidence: { field: 'doc', tier: 1 } });
  });
});
