/**
 * Abstention on the retrieval-backed handlers
 * (change: abstain-when-retrieval-is-uncovered).
 *
 * The 2026-09-20 case: a question about interface behavior returned three
 * confidently-ranked symbols and an insertion point inside a function that had nothing
 * to do with it. The handlers now say what their results are worth, and withhold the
 * ranked list entirely when nothing matched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatchEvidence } from '../../analyzer/retrieval-evidence.js';

const ANALYSIS = join('.openlore', 'analysis');

function makeRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a::src/a.ts',
    name: 'restartServer',
    filePath: 'src/a.ts',
    language: 'typescript',
    signature: '() => void',
    docstring: '',
    fanIn: 1,
    fanOut: 1,
    isHub: false,
    isEntryPoint: false,
    className: '',
    ...over,
  };
}

const incidental: MatchEvidence = { field: 'body', terms: ['spinner'], tier: 2 };

describe('retrieval handlers — coverage verdict and abstention', () => {
  let tmpDir: string;
  // The served retrieval mode depends on the ambient environment; pin it so the
  // keyword-note assertion tests the code rather than the developer's shell.
  const savedEmbedEnv = { base: process.env.EMBED_BASE_URL, model: process.env.EMBED_MODEL };

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-abstain-'));
    await mkdir(join(tmpDir, ANALYSIS), { recursive: true });
    await writeFile(join(tmpDir, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'anthropic', model: 'claude-sonnet-5' },
      createdAt: '2026-09-20T00:00:00.000Z',
      lastRun: null,
    }), 'utf-8');
  });

  afterEach(async () => {
    if (savedEmbedEnv.base === undefined) delete process.env.EMBED_BASE_URL; else process.env.EMBED_BASE_URL = savedEmbedEnv.base;
    if (savedEmbedEnv.model === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = savedEmbedEnv.model;
    vi.doUnmock('../../analyzer/vector-index.js');
    await rm(tmpDir, { recursive: true, force: true });
  });

  const mockSearch = (results: unknown[]): void => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue(results),
        degradationNotice: vi.fn().mockReturnValue(null),
        keywordMissDiagnostics: vi.fn().mockResolvedValue({ missedTokens: [], nearTokens: [] }),
      },
    }));
  };

  it('search_code withholds the ranked list when nothing matched', async () => {
    mockSearch([]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'what stops the spinner') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.verdict).toBe('uncovered');
    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
    expect(coverage.reason).toContain('Nothing in the index matched');
  });

  it('search_code states when every result rests on incidental evidence', async () => {
    mockSearch([{ score: 0.4, scoreKind: 'bm25', record: makeRecord(), matchEvidence: incidental }]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'what stops the spinner') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.verdict).toBe('weak');
    expect(coverage.reason).toContain('incidental evidence');
    // A weak verdict still returns its results — it labels them, it does not hide them.
    expect((result.results as unknown[]).length).toBe(1);
  });

  it('search_code leaves a covered answer unchanged apart from the verdict', async () => {
    mockSearch([{
      score: 2.1,
      scoreKind: 'bm25',
      record: makeRecord({ name: 'stopSpinner' }),
      matchEvidence: { field: 'symbol', terms: ['spinner'], tier: 1 } satisfies MatchEvidence,
    }]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'spinner') as Record<string, unknown>;

    expect((result.coverage as Record<string, unknown>).verdict).toBe('covered');
    expect((result.results as unknown[]).length).toBe(1);
  });

  it('search_code keeps the keyword-upgrade note while abstaining', async () => {
    mockSearch([]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'nothing matches this') as Record<string, unknown>;

    // An uncovered result under keyword mode is exactly when the upgrade hint matters.
    expect(result.note).toContain('Keyword (BM25)');
  });

  it('names the question kind the caller declared, and the tool that answers it', async () => {
    mockSearch([]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'who calls this', 10, undefined, undefined, undefined, undefined, 'who-calls') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.questionKind).toBe('who-calls');
    expect(coverage.answeredBy).toBe('analyze_impact');
  });

  it('admits the question kind no tool answers', async () => {
    mockSearch([]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'what makes the spinner appear', 10, undefined, undefined, undefined, undefined, 'what-gates') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.answeredBy).toBeUndefined();
    expect(coverage.reason).toContain('no shipped tool');
  });

  it('suggest_insertion_points recommends nothing when retrieval is uncovered', async () => {
    mockSearch([]);
    const { handleSuggestInsertionPoints } = await import('./semantic.js');

    const result = await handleSuggestInsertionPoints(tmpDir, 'make the spinner stop') as Record<string, unknown>;

    expect((result.coverage as Record<string, unknown>).verdict).toBe('uncovered');
    expect(result.candidates).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('suggest_insertion_points still answers when retrieval is covered', async () => {
    mockSearch([{
      score: 1.8,
      record: makeRecord({ name: 'spinnerReducer' }),
      matchEvidence: { field: 'symbol', terms: ['spinner'], tier: 1 } satisfies MatchEvidence,
    }]);
    const { handleSuggestInsertionPoints } = await import('./semantic.js');

    const result = await handleSuggestInsertionPoints(tmpDir, 'spinner') as Record<string, unknown>;

    expect(result.count).toBe(1);
    expect((result.candidates as unknown[]).length).toBe(1);
  });

  it('suggest_insertion_points returns locations but no advice on weak evidence', async () => {
    mockSearch([{ score: 0.6, record: makeRecord(), matchEvidence: incidental }]);
    const { handleSuggestInsertionPoints } = await import('./semantic.js');

    const result = await handleSuggestInsertionPoints(tmpDir, 'make the spinner stop') as Record<string, unknown>;

    expect((result.coverage as Record<string, unknown>).verdict).toBe('weak');
    const candidates = result.candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBe(1);
    // The location is still worth inspecting; the instruction built on it is not.
    expect(candidates[0].name).toBe('restartServer');
    expect(candidates[0].insertionStrategy).toBeUndefined();
    expect(result.nextSteps).toBeUndefined();
  });

  it('suggest_insertion_points keeps strategy and next steps when covered', async () => {
    mockSearch([{
      score: 1.8,
      record: makeRecord({ name: 'spinnerReducer' }),
      matchEvidence: { field: 'symbol', terms: ['spinner'], tier: 1 } satisfies MatchEvidence,
    }]);
    const { handleSuggestInsertionPoints } = await import('./semantic.js');

    const result = await handleSuggestInsertionPoints(tmpDir, 'spinner') as Record<string, unknown>;

    const candidates = result.candidates as Array<Record<string, unknown>>;
    expect(typeof candidates[0].insertionStrategy).toBe('string');
    expect((result.nextSteps as string[]).length).toBe(3);
  });

  it('does not abstain when the retriever supplied no evidence to judge', async () => {
    // Coverage cannot be judged without evidence; suppressing an answer on a missing
    // field would be its own dishonesty.
    mockSearch([{ score: 1.0, record: makeRecord() }]);
    const { handleSuggestInsertionPoints } = await import('./semantic.js');

    const result = await handleSuggestInsertionPoints(tmpDir, 'spinner') as Record<string, unknown>;

    expect(result.count).toBe(1);
  });
});
