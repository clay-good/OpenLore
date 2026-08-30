import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyRole, deriveStrategy, buildReason, compositeScore } from './semantic.js';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { TextLineIndex } from '../../analyzer/text-line-index.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<{
  id: string; name: string; filePath: string; language: string;
  fanIn: number; fanOut: number; isHub: boolean; isEntryPoint: boolean;
  signature: string; docstring: string; className: string | null;
}> = {}) {
  return {
    id: 'src/a.ts::doA', name: 'doA', filePath: 'src/a.ts',
    language: 'TypeScript', fanIn: 1, fanOut: 1,
    isHub: false, isEntryPoint: false,
    signature: 'function doA()', docstring: '', className: null,
    ...overrides,
  };
}

const TEST_MATCH_EVIDENCE = { field: 'symbol' as const, terms: ['do'], tier: 1 as const };

async function writeAnalysisFile(dir: string, filename: string, content: object) {
  const analysisDir = join(dir, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  await writeFile(join(analysisDir, filename), JSON.stringify(content), 'utf-8');
}

async function writeOpenLoreConfig(dir: string, openspecPath: string) {
  await mkdir(join(dir, '.openlore'), { recursive: true });
  await writeFile(join(dir, '.openlore', 'config.json'), JSON.stringify({
    version: '1.0.0',
    projectType: 'nodejs',
    openspecPath,
    analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
    generation: { domains: 'auto' },
    createdAt: '2026-08-30T00:00:00.000Z',
    lastRun: null,
  }), 'utf-8');
}

// ============================================================================
// MOCK validateDirectory
// ============================================================================

// We mock validateDirectory so tests don't need a real .openlore/config.json.
// loadMappingIndex is kept as the real implementation (it gracefully returns null if file absent).
vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    validateDirectory: vi.fn(async (dir: string) => dir),
  };
});

// ============================================================================
// TESTS — Pure helper functions
// ============================================================================

describe('classifyRole', () => {
  it('returns entry_point when isEntryPoint=true', () => {
    expect(classifyRole(0, 0, false, true)).toBe('entry_point');
  });
  it('returns hub when isHub=true (and not entry_point)', () => {
    expect(classifyRole(5, 5, true, false)).toBe('hub');
  });
  it('returns orchestrator when fanOut is high', () => {
    // INSERTION_ORCHESTRATOR_FAN_OUT_THRESHOLD = 5 (from constants)
    expect(classifyRole(0, 10, false, false)).toBe('orchestrator');
  });
  it('returns utility when fanIn <= 1', () => {
    expect(classifyRole(1, 2, false, false)).toBe('utility');
  });
  it('returns internal otherwise', () => {
    expect(classifyRole(3, 2, false, false)).toBe('internal');
  });
});

describe('deriveStrategy', () => {
  it('maps entry_point → extend_entry_point', () => {
    expect(deriveStrategy('entry_point')).toBe('extend_entry_point');
  });
  it('maps orchestrator → add_orchestration_step', () => {
    expect(deriveStrategy('orchestrator')).toBe('add_orchestration_step');
  });
  it('maps hub → cross_cutting_hook', () => {
    expect(deriveStrategy('hub')).toBe('cross_cutting_hook');
  });
  it('maps utility → extract_shared_logic', () => {
    expect(deriveStrategy('utility')).toBe('extract_shared_logic');
  });
  it('maps internal → call_alongside', () => {
    expect(deriveStrategy('internal')).toBe('call_alongside');
  });
});

describe('buildReason', () => {
  it('mentions entry point for extend_entry_point strategy', () => {
    const r = buildReason('myFn', 'entry_point', 'extend_entry_point', 0, 0);
    expect(r).toContain('myFn');
    expect(r).toContain('entry point');
  });
  it('mentions fanOut for add_orchestration_step strategy', () => {
    const r = buildReason('orchestrate', 'orchestrator', 'add_orchestration_step', 0, 8);
    expect(r).toContain('8');
  });
  it('mentions fanIn for cross_cutting_hook strategy', () => {
    const r = buildReason('hubFn', 'hub', 'cross_cutting_hook', 12, 0);
    expect(r).toContain('12');
  });
  it('mentions shared logic for extract_shared_logic strategy', () => {
    const r = buildReason('utilFn', 'utility', 'extract_shared_logic', 0, 0);
    expect(r).toContain('utilFn');
  });
  it('falls back to default reason for call_alongside strategy', () => {
    const r = buildReason('internalFn', 'internal', 'call_alongside', 2, 2);
    expect(r).toContain('internalFn');
  });
});

describe('compositeScore', () => {
  it('returns a number between 0 and 1 for typical relevance inputs', () => {
    const s = compositeScore(0.7, 'hub');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
  it('gives higher score to entry_point than internal at same relevance', () => {
    const ep = compositeScore(0.7, 'entry_point');
    const internal = compositeScore(0.7, 'internal');
    expect(ep).toBeGreaterThan(internal);
  });
  it('clamps semantic component to [0, 1] range', () => {
    // relevance > 1 → clamped to 1
    const high = compositeScore(1.5, 'utility');
    const one = compositeScore(1.0, 'utility');
    expect(high).toBe(one);
    // relevance 0 → semantic component is 0, score is purely structural
    const zero = compositeScore(0, 'utility');
    expect(zero).toBeGreaterThanOrEqual(0);
  });
  it('higher relevance produces higher composite score for same role', () => {
    const high = compositeScore(0.9, 'orchestrator');
    const low = compositeScore(0.1, 'orchestrator');
    expect(high).toBeGreaterThan(low);
  });
});

// ============================================================================
// TESTS — handleListSpecDomains
// ============================================================================

describe('handleListSpecDomains', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-semantic-test-'));
  });

  it('returns empty domains when openspec/specs/ does not exist', async () => {
    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; note?: string };
    expect(result.domains).toEqual([]);
    expect(result.note).toContain('No openspec/specs/');
  });

  it('returns the list of domains that have a spec.md', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs');
    await mkdir(join(specsDir, 'auth'), { recursive: true });
    await mkdir(join(specsDir, 'crawler'), { recursive: true });
    await mkdir(join(specsDir, 'empty-domain'), { recursive: true }); // no spec.md
    await writeFile(join(specsDir, 'auth', 'spec.md'), '# Auth', 'utf-8');
    await writeFile(join(specsDir, 'crawler', 'spec.md'), '# Crawler', 'utf-8');

    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; count: number };
    expect(result.domains).toContain('auth');
    expect(result.domains).toContain('crawler');
    expect(result.domains).not.toContain('empty-domain');
    expect(result.count).toBe(2);
  });

  it('returns count matching number of domains', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs');
    await mkdir(join(specsDir, 'billing'), { recursive: true });
    await writeFile(join(specsDir, 'billing', 'spec.md'), '# Billing', 'utf-8');

    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; count: number };
    expect(result.count).toBe(result.domains.length);
  });

  it('reads domains from the configured in-project spec root', async () => {
    await writeOpenLoreConfig(tmpDir, 'contracts');
    const specsDir = join(tmpDir, 'contracts', 'specs', 'billing');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), '# Billing', 'utf-8');

    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; count: number };
    expect(result).toMatchObject({ domains: ['billing'], count: 1 });
  });

  it('confines a configured spec root that escapes the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-semantic-outside-'));
    try {
      await mkdir(join(outside, 'specs', 'secret'), { recursive: true });
      await writeFile(join(outside, 'specs', 'secret', 'spec.md'), '# Secret', 'utf-8');
      await writeOpenLoreConfig(tmpDir, outside);

      const { handleListSpecDomains } = await import('./semantic.js');
      const result = await handleListSpecDomains(tmpDir) as { domains: string[] };
      expect(result.domains).not.toContain('secret');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// TESTS — handleSearchSpecs (error paths — no LanceDB needed)
// ============================================================================

describe('handleSearchSpecs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-search-specs-test-'));
  });

  it('returns an error object when no spec index exists', async () => {
    // Mock SpecVectorIndex.exists to return false
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: {
        exists: vi.fn().mockReturnValue(false),
        build: vi.fn(),
        search: vi.fn(),
      },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'email validation') as { error: string; hint: string };
    expect(result.error).toContain('No spec index found');
    expect(result.hint).toContain('keyword');
  });
});

// ============================================================================
// TESTS — handleGetSpec
// ============================================================================

describe('handleGetSpec', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-get-spec-test-'));
  });

  it('returns error when domain spec file does not exist', async () => {
    const { handleGetSpec } = await import('./semantic.js');
    const result = await handleGetSpec(tmpDir, 'nonexistent') as { error: string };
    expect(result.error).toContain('"nonexistent"');
    expect(result.error).toContain('list_spec_domains');
  });

  it('returns spec content when spec.md exists', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), '# Auth Spec\n\nThis is the auth domain.', 'utf-8');

    const { handleGetSpec } = await import('./semantic.js');
    const result = await handleGetSpec(tmpDir, 'auth') as { domain: string; content: string; specFile: string; provenance: string };
    expect(result.domain).toBe('auth');
    expect(result.content).toContain('Auth Spec');
    expect(result.specFile).toBe('openspec/specs/auth/spec.md');
    expect(result.provenance).toBe('local-unreviewed');
  });

  it('returns spec content from the configured in-project spec root', async () => {
    await writeOpenLoreConfig(tmpDir, './contracts/');
    const specsDir = join(tmpDir, 'contracts', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), '# Relocated Auth', 'utf-8');

    const { handleGetSpec } = await import('./semantic.js');
    const result = await handleGetSpec(tmpDir, 'auth') as {
      content: string; specFile: string; provenance: string;
    };
    expect(result.content).toContain('Relocated Auth');
    expect(result.specFile).toBe('contracts/specs/auth/spec.md');
    expect(result.provenance).toBe('local-unreviewed');
  });

  it('blocks path traversal via the domain arg (must not read outside the repo)', async () => {
    // Plant a spec.md two levels up; a traversing domain must NOT reach it.
    const outside = join(tmpDir, '..', `escape-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'spec.md'), '# SECRET should not be readable', 'utf-8');
    try {
      const { handleGetSpec } = await import('./semantic.js');
      const result = await handleGetSpec(tmpDir, `../escape-${Date.now()}`) as { error?: string; content?: string };
      expect(result.content).toBeUndefined();
      expect(result.error).toContain('list_spec_domains');
      // also the classic deep escape
      const deep = await handleGetSpec(tmpDir, '../../../../../../etc') as { error?: string; content?: string };
      expect(deep.content).toBeUndefined();
      expect(deep.error).toBeTruthy();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// TESTS — handleSearchCode
// ============================================================================

describe('handleSearchCode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-search-code-'));
  });

  it('returns error when no vector index exists', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(false), search: vi.fn() },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn(), fromConfig: vi.fn() },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'auth handler') as { error: string };
    expect(result.error).toContain('No search index found');
  });

  it('returns results with bm25_fallback when embedding service unavailable', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{
          score: 0.1,
          matchEvidence: TEST_MATCH_EVIDENCE,
          record: { id: 'src/a.ts::doA', name: 'doA', filePath: 'src/a.ts', signature: 'fn doA()', docstring: '', language: 'TypeScript', fanIn: 1, fanOut: 1, isHub: false, isEntryPoint: false },
        }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'do something') as Record<string, unknown>;
    expect(result.searchMode).toBe('bm25_fallback');
    expect(result.count).toBe(1);
    expect(Array.isArray(result.results)).toBe(true);
    expect((result.indexStaleness as { staleFiles: string[] }).staleFiles).toEqual(['src/a.ts']);
  });

  it('checks stale text-index citations outside the programming-language allowlist', async () => {
    const analysisDir = join(tmpDir, '.openlore', 'analysis');
    const cssPath = join(tmpDir, 'src', 'styles.css');
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await mkdir(analysisDir, { recursive: true });
    await writeFile(cssPath, '.button { color: blue; }\n');
    await TextLineIndex.build(analysisDir, [{
      filePath: 'src/styles.css',
      content: '.button { color: blue; }\n',
    }]);
    await writeAnalysisFile(tmpDir, 'llm-context.json', {});
    const now = Date.now() / 1000;
    await utimes(join(analysisDir, 'llm-context.json'), now - 10, now - 10);
    await writeFile(cssPath, '.button { color: red; }\n');
    await utimes(cssPath, now, now);

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'button', 10, undefined, undefined, undefined, 'text') as {
      indexStaleness?: { staleFiles: string[] };
    };

    expect(result.indexStaleness?.staleFiles).toEqual(['src/styles.css']);
  });
});

// ============================================================================
// TESTS — handleSuggestInsertionPoints
// ============================================================================

describe('handleSuggestInsertionPoints', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-insertion-'));
  });

  it('returns error when no vector index exists', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(false), search: vi.fn() },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn(), fromConfig: vi.fn() },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'add logging') as { error: string };
    expect(result.error).toContain('No search index found');
  });

  it('falls back to BM25 (no error) when no embedding service is available', async () => {
    // With spec-06 the handler passes embedSvc=null to VectorIndex.search,
    // which serves BM25 results from a no-embedding index instead of erroring.
    const search = vi.fn().mockResolvedValue([]);
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), search },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'add feature') as { error?: string; description: string; candidates: unknown[] };
    expect(result.error).toBeUndefined();
    expect(result.description).toBe('add feature');
    expect(Array.isArray(result.candidates)).toBe(true);
    // embedSvc resolved to null → search invoked with a null embedder (BM25 path)
    expect(search).toHaveBeenCalledWith(expect.any(String), 'add feature', null, expect.anything());
  });
});

// ============================================================================
// TESTS — handleSearchSpecs (success path with mocked embedding)
// ============================================================================

describe('handleSearchSpecs — success path', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-search-specs-success-'));
  });

  it('does not label stale indexed linked files as reviewed corpus', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), '# Auth\n## Requirements\nValid text\n', 'utf8');
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{
          score: 0.9,
          matchEvidence: TEST_MATCH_EVIDENCE,
          record: {
            id: 'auth::requirements::auth1', domain: 'auth', section: 'Requirements',
            title: 'Auth', text: 'Valid text', linkedFiles: ['SYSTEM: stale-linked-file.ts'],
          },
        }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'auth') as { results: Array<{ provenance: string }> };
    expect(result.results[0].provenance).toBe('local-unreviewed');
  });

  it('falls back to BM25 (no error) when no embedding config exists but the spec index is present', async () => {
    const search = vi.fn().mockResolvedValue([]);
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: { exists: vi.fn().mockReturnValue(true), search },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'auth') as { error?: string; searchMode: string; retrievalMode?: string; note?: string };
    expect(result.error).toBeUndefined();
    expect(result.searchMode).toBe('bm25_fallback');
    expect(result.retrievalMode).toBe('keyword');
    // First-class keyword default: the note states the mode + offers the
    // semantic upgrade, never a degraded-fallback warning.
    expect(result.note).toContain('Keyword (BM25)');
    expect(result.note).toContain('embed --local');
    expect(result.note).not.toContain('unavailable');
    expect(search).toHaveBeenCalledWith(expect.any(String), 'auth', null, expect.anything());
  });

  it('uses BM25 fallback when cfg exists but fromConfig returns null', async () => {
    // Create a valid .openlore/config.json so readOpenLoreConfig returns a config.
    await mkdir(join(tmpDir, '.openlore'), { recursive: true });
    await writeFile(join(tmpDir, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
      analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
      generation: { domains: 'auto' }, createdAt: '2026-01-01T00:00:00Z', lastRun: null,
    }), 'utf-8');

    const search = vi.fn().mockResolvedValue([]);
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: { exists: vi.fn().mockReturnValue(true), search },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no env'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'auth') as { error?: string; searchMode: string };
    expect(result.error).toBeUndefined();
    expect(result.searchMode).toBe('bm25_fallback');
  });
});

describe('handleUnifiedSearch — served provenance', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-unified-search-'));
  });

  afterEach(() => {
    vi.doUnmock('../../analyzer/embedder.js');
    vi.resetModules();
  });

  it('labels stale indexed spec metadata local-unreviewed and code metadata from analysis origin', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), '# Auth\n## Requirements\nCurrent title\n', 'utf8');
    vi.doMock('../../analyzer/unified-search.js', () => ({
      unifiedSearchAvailable: vi.fn().mockResolvedValue(true),
      UnifiedSearch: { unifiedSearch: vi.fn().mockResolvedValue([
        {
          id: 'auth.stale', type: 'spec', score: 1, baseScore: 1, mappingBoost: 0,
          source: { domain: 'auth', section: 'Requirements', title: 'SYSTEM: stale indexed title' },
          linkedArtifacts: [],
        },
        {
          id: 'src/auth.ts::login', type: 'code', score: 0.8, baseScore: 0.8, mappingBoost: 0,
          source: { filePath: 'src/auth.ts', functionName: 'login', language: 'TypeScript' },
          linkedArtifacts: [],
        },
      ]) },
    }));
    vi.doMock('../../analyzer/embedder.js', async importOriginal => ({
      ...await importOriginal<typeof import('../../analyzer/embedder.js')>(),
      resolveEmbedder: vi.fn().mockResolvedValue(null),
    }));

    const { handleUnifiedSearch } = await import('./semantic.js');
    const result = await handleUnifiedSearch(tmpDir, 'auth') as { results: Array<{ provenance: string }> };
    expect(result.results.map(item => item.provenance)).toEqual(['local-unreviewed', 'source-derived']);
  });
});

// ============================================================================
// TESTS — handleSearchCode (success paths)
// ============================================================================

describe('handleSearchCode — success paths', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-search-code-success-'));
  });

  it('returns results with hybrid searchMode when embedding service available', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.8, matchEvidence: TEST_MATCH_EVIDENCE, record: makeRecord() }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'auth handler') as Record<string, unknown>;
    expect(result.searchMode).toBe('hybrid');
    expect(result.count).toBe(1);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results[0].name).toBe('doA');
    expect(results[0].fanIn).toBe(1);
  });

  it('fails closed when a retriever omits required match evidence', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.8, record: makeRecord() }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    await expect(handleSearchCode(tmpDir, 'auth handler')).rejects.toThrow('missing match evidence');
  });

  it('clamps limit to [1, 100]', async () => {
    const searchMock = vi.fn().mockResolvedValue([]);
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), search: searchMock },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    await handleSearchCode(tmpDir, 'query', 200);
    expect((searchMock.mock.calls[0][3] as { limit: number }).limit).toBe(100);

    await handleSearchCode(tmpDir, 'query', 0);
    expect((searchMock.mock.calls[1][3] as { limit: number }).limit).toBe(1);
  });

  it('enriches results with callers and callees from call graph', async () => {
    const record = makeRecord({ id: 'src/a.ts::doA' });
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.7, matchEvidence: TEST_MATCH_EVIDENCE, record }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));
    await writeAnalysisFile(tmpDir, 'llm-context.json', {
      callGraph: {
        nodes: [
          { id: 'src/a.ts::doA', name: 'doA', filePath: 'src/a.ts', language: 'TypeScript', fanIn: 1, fanOut: 0, startLine: 17 },
          { id: 'src/b.ts::doB', name: 'doB', filePath: 'src/b.ts', language: 'TypeScript', fanIn: 0, fanOut: 1 },
        ],
        edges: [{ callerId: 'src/b.ts::doB', calleeId: 'src/a.ts::doA' }],
      },
    });
    {
      const analysisDir = join(tmpDir, '.openlore', 'analysis');
      const store = EdgeStore.open(EdgeStore.dbPath(analysisDir));
      store.insertNodes([
        { id: 'src/a.ts::doA', name: 'doA', filePath: 'src/a.ts', language: 'TypeScript', fanIn: 1, fanOut: 0, isAsync: false, startIndex: 0, endIndex: 100 },
        { id: 'src/b.ts::doB', name: 'doB', filePath: 'src/b.ts', language: 'TypeScript', fanIn: 0, fanOut: 1, isAsync: false, startIndex: 0, endIndex: 100 },
      ]);
      store.insertEdges([{ callerId: 'src/b.ts::doB', calleeId: 'src/a.ts::doA', calleeName: 'doA', confidence: 'name_only' as const }]);
      store.close();
    }

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'do A') as Record<string, unknown>;
    const results = result.results as Array<Record<string, unknown>>;
    const callers = results[0].callers as Array<{ name: string }> | undefined;
    expect(callers).toBeDefined();
    expect(callers?.some(c => c.name === 'doB')).toBe(true);
    expect(results[0].startLine).toBe(17);
  });

  it('preserves indexed TypeScript, Python, and Go start lines by canonical id', async () => {
    const records = [
      makeRecord({ id: 'src/a.ts::same', filePath: 'src/a.ts', language: 'TypeScript' }),
      makeRecord({ id: 'src/a.py::same', filePath: 'src/a.py', language: 'Python' }),
      makeRecord({ id: 'src/a.go::same', filePath: 'src/a.go', language: 'Go' }),
    ];
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), search: vi.fn().mockResolvedValue(records.map(record => ({ score: 0.8, matchEvidence: TEST_MATCH_EVIDENCE, record }))) },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));
    await writeAnalysisFile(tmpDir, 'llm-context.json', {
      callGraph: { nodes: records.map((record, index) => ({ ...record, startLine: [11, 22, 33][index] })), edges: [] },
    });
    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'same') as { results: Array<{ language: string; startLine?: number }> };
    expect(result.results.map(item => [item.language, item.startLine])).toEqual([
      ['TypeScript', 11], ['Python', 22], ['Go', 33],
    ]);
  });

  it('includes specPeers for files that share a domain via mapping.json', async () => {
    const record = makeRecord({ id: 'src/a.ts::doA', filePath: 'src/a.ts' });
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.6, matchEvidence: TEST_MATCH_EVIDENCE, record }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));
    // mapping.json: doA in src/a.ts → domain 'auth'; peerFn in src/c.ts also in 'auth'
    await writeAnalysisFile(tmpDir, 'mapping.json', {
      mappings: [
        {
          requirement: 'AuthReq', service: 'auth', domain: 'auth', specFile: 'openspec/specs/auth/spec.md',
          functions: [{ name: 'doA', file: 'src/a.ts', line: 1, kind: 'function', confidence: 'high' }],
        },
        {
          requirement: 'AuthReq2', service: 'auth', domain: 'auth', specFile: 'openspec/specs/auth/spec.md',
          functions: [{ name: 'peerFn', file: 'src/c.ts', line: 5, kind: 'function', confidence: 'medium' }],
        },
      ],
    });

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'auth') as Record<string, unknown>;
    expect(result).toHaveProperty('specLinkedFunctions');
    const peers = result.specLinkedFunctions as Array<{ name: string }>;
    expect(peers.some(p => p.name === 'peerFn')).toBe(true);
  });
});

// ============================================================================
// TESTS — handleSuggestInsertionPoints (success paths)
// ============================================================================

describe('handleSuggestInsertionPoints — success paths', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-insertion-success-'));
  });

  it('returns ranked candidates with correct roles and strategies', async () => {
    const results = [
      { score: 0.9, record: makeRecord({ id: 'a', name: 'processAuth', filePath: 'src/auth.ts', isEntryPoint: true }) },
      { score: 0.5, record: makeRecord({ id: 'b', name: 'validateToken', filePath: 'src/token.ts', fanIn: 8, isHub: true }) },
    ];
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), search: vi.fn().mockResolvedValue(results) },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'add auth check') as Record<string, unknown>;
    expect(result.count).toBeGreaterThan(0);
    const candidates = result.candidates as Array<Record<string, unknown>>;
    expect(candidates[0].rank).toBe(1);
    expect(candidates.every(c => typeof c.score === 'number')).toBe(true);
    expect(candidates.every(c => typeof c.insertionStrategy === 'string')).toBe(true);
    expect(candidates.every(c => typeof c.reason === 'string')).toBe(true);
  });

  it('returns three nextSteps when candidates found', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.8, matchEvidence: TEST_MATCH_EVIDENCE, record: makeRecord() }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'some feature') as Record<string, unknown>;
    const nextSteps = result.nextSteps as string[];
    expect(nextSteps).toHaveLength(3);
    expect(nextSteps.some(s => s.includes('get_function_skeleton'))).toBe(true);
  });

  it('returns fallback nextSteps when no candidates found', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), search: vi.fn().mockResolvedValue([]) },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'some feature') as Record<string, unknown>;
    expect(result.count).toBe(0);
    const nextSteps = result.nextSteps as string[];
    expect(nextSteps[0]).toContain('No candidates');
  });

  it('adds caller graph-expansion candidates (RIG-13)', async () => {
    const seedRecord = makeRecord({ id: 'seed::fn', name: 'seedFn', filePath: 'src/seed.ts' });
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.7, matchEvidence: TEST_MATCH_EVIDENCE, record: seedRecord }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));
    // callerNode calls seedFn — should be added via RIG-13
    await writeAnalysisFile(tmpDir, 'llm-context.json', {
      callGraph: {
        nodes: [
          { id: 'seed::fn', name: 'seedFn', filePath: 'src/seed.ts', language: 'TypeScript', fanIn: 1, fanOut: 0 },
          { id: 'caller::fn', name: 'callerFn', filePath: 'src/caller.ts', language: 'TypeScript', fanIn: 0, fanOut: 1 },
        ],
        edges: [{ callerId: 'caller::fn', calleeId: 'seed::fn' }],
      },
    });
    {
      const analysisDir = join(tmpDir, '.openlore', 'analysis');
      const store = EdgeStore.open(EdgeStore.dbPath(analysisDir));
      store.insertNodes([
        { id: 'seed::fn', name: 'seedFn', filePath: 'src/seed.ts', language: 'TypeScript', fanIn: 1, fanOut: 0, isAsync: false, startIndex: 0, endIndex: 100 },
        { id: 'caller::fn', name: 'callerFn', filePath: 'src/caller.ts', language: 'TypeScript', fanIn: 0, fanOut: 1, isAsync: false, startIndex: 0, endIndex: 100 },
      ]);
      store.insertEdges([{ callerId: 'caller::fn', calleeId: 'seed::fn', calleeName: 'seedFn', confidence: 'name_only' as const }]);
      store.close();
    }

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'add feature', 10) as Record<string, unknown>;
    const candidates = result.candidates as Array<Record<string, unknown>>;
    expect(candidates.some(c => c.name === 'callerFn')).toBe(true);
  });

  it('clamps limit to [1, 20]', async () => {
    const searchMock = vi.fn().mockResolvedValue([]);
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), search: searchMock },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    await handleSuggestInsertionPoints(tmpDir, 'query', 50);
    // search is called with limit * 4 — clamped limit=20 → 80
    const callLimit = (searchMock.mock.calls[0][3] as { limit: number }).limit;
    expect(callLimit).toBe(20 * 4);
  });
});

// ============================================================================
// TESTS — handleSearchSpecs (success path)
// ============================================================================

describe('handleSearchSpecs — success path', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-search-specs-ok-'));
  });

  it('returns formatted spec results', async () => {
    const mockResults = [{
      score: 0.9,
      matchEvidence: TEST_MATCH_EVIDENCE,
      record: {
        id: 'auth::requirements::auth1', domain: 'auth',
        section: 'requirements', title: 'Auth requirement',
        text: 'User must authenticate before accessing the system',
        linkedFiles: ['src/auth.ts'],
      },
    }];
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue(mockResults),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'authentication') as Record<string, unknown>;
    expect(result.query).toBe('authentication');
    expect(result.count).toBe(1);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results[0].domain).toBe('auth');
    expect(results[0].score).toBe(0.9);
    expect(results[0].text).toContain('authenticate');
    expect(results[0].linkedFiles).toEqual(['src/auth.ts']);
  });

  it('clamps limit to [1, 50]', async () => {
    const searchMock = vi.fn().mockResolvedValue([]);
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: { exists: vi.fn().mockReturnValue(true), search: searchMock },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    await handleSearchSpecs(tmpDir, 'query', 100);
    const callLimit = (searchMock.mock.calls[0][3] as { limit: number }).limit;
    expect(callLimit).toBe(50);
  });
});

// ============================================================================
// TESTS — handleGetSpec with mapping
// ============================================================================

describe('handleGetSpec — with mapping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-get-spec-mapping-'));
  });

  it('returns linkedFunctions when mapping.json covers the domain', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs', 'auth');
    await mkdir(specsDir, { recursive: true });
    await writeFile(join(specsDir, 'spec.md'), '# Auth Spec', 'utf-8');
    await writeAnalysisFile(tmpDir, 'mapping.json', {
      mappings: [{
        requirement: 'AuthReq', service: 'auth', domain: 'auth',
        specFile: 'openspec/specs/auth/spec.md',
        functions: [{ name: 'checkAuth', file: 'src/auth.ts', line: 10, kind: 'function', confidence: 'high' }],
      }],
    });

    const { handleGetSpec } = await import('./semantic.js');
    const result = await handleGetSpec(tmpDir, 'auth') as { domain: string; linkedFunctions?: unknown[] };
    expect(result.linkedFunctions).toBeDefined();
    expect(Array.isArray(result.linkedFunctions)).toBe(true);
    const fns = result.linkedFunctions as Array<{ name: string }>;
    expect(fns.some(f => f.name === 'checkAuth')).toBe(true);
  });
});

// ============================================================================
// TESTS — edgeStore fast paths
// ============================================================================

describe('handleSearchCode — edgeStore fast path', () => {
  let tmpDir: string;
  let store: EdgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'semantic-edgestore-test-'));
    const analysisDir = join(tmpDir, '.openlore', 'analysis');
    rmSync(analysisDir, { recursive: true, force: true });
    mkdirSync(analysisDir, { recursive: true });
    // Write minimal llm-context.json (no callGraph — edgeStore is the only source)
    writeFileSync(
      join(analysisDir, 'llm-context.json'),
      JSON.stringify({ phase1_survey: { purpose: '', files: [], totalTokens: 0 }, phase2_deep: { purpose: '', files: [], totalTokens: 0 }, phase3_validation: { purpose: '', files: [], totalTokens: 0 } })
    );
    store = EdgeStore.open(join(analysisDir, 'call-graph.db'));
    store.insertNodes([
      { id: 'src/a.ts::doA', name: 'doA', filePath: 'src/a.ts', isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 1, fanOut: 0 },
      { id: 'src/b.ts::doB', name: 'doB', filePath: 'src/b.ts', isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 1 },
    ]);
    store.insertEdges([{ callerId: 'src/b.ts::doB', calleeId: 'src/a.ts::doA', calleeName: 'doA', confidence: 'import' }]);
    store.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enriches results with callers from edgeStore (not JSON scan)', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.9, matchEvidence: TEST_MATCH_EVIDENCE, record: makeRecord({ id: 'src/a.ts::doA' }) }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSearchCode } = await import('./semantic.js');
    const result = await handleSearchCode(tmpDir, 'doA') as Record<string, unknown>;
    const results = result.results as Array<Record<string, unknown>>;
    const callers = results[0].callers as Array<{ name: string }> | undefined;
    expect(callers).toBeDefined();
    expect(callers?.some(c => c.name === 'doB')).toBe(true);
  });
});

describe('handleSuggestInsertionPoints — edgeStore RIG-13 fast path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'semantic-suggest-edgestore-test-'));
    const analysisDir = join(tmpDir, '.openlore', 'analysis');
    mkdirSync(analysisDir, { recursive: true });
    writeFileSync(
      join(analysisDir, 'llm-context.json'),
      JSON.stringify({ phase1_survey: { purpose: '', files: [], totalTokens: 0 }, phase2_deep: { purpose: '', files: [], totalTokens: 0 }, phase3_validation: { purpose: '', files: [], totalTokens: 0 } })
    );
    // orchestrator → handler (caller expands handler's insertion candidates)
    const s = EdgeStore.open(join(analysisDir, 'call-graph.db'));
    s.insertNodes([
      { id: 'src/a.ts::handler',     name: 'handler',     filePath: 'src/a.ts', isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 1, fanOut: 0 },
      { id: 'src/b.ts::orchestrate', name: 'orchestrate', filePath: 'src/b.ts', isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 5 },
    ]);
    s.insertEdges([{ callerId: 'src/b.ts::orchestrate', calleeId: 'src/a.ts::handler', calleeName: 'handler', confidence: 'import' }]);
    s.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('RIG-13 expands results with caller from edgeStore', async () => {
    vi.doMock('../../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        search: vi.fn().mockResolvedValue([{ score: 0.8, matchEvidence: TEST_MATCH_EVIDENCE, record: makeRecord({ id: 'src/a.ts::handler', name: 'handler', filePath: 'src/a.ts', fanOut: 0 }) }]),
      },
    }));
    vi.doMock('../../analyzer/embedding-service.js', () => ({
      EmbeddingService: { fromEnv: vi.fn().mockReturnValue({}), fromConfig: vi.fn() },
    }));

    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const result = await handleSuggestInsertionPoints(tmpDir, 'add logging') as Record<string, unknown>;
    const candidates = result.candidates as Array<{ name: string }>;
    // orchestrate should appear as a RIG-13 expanded candidate
    expect(candidates.some(p => p.name === 'orchestrate')).toBe(true);
  });
});
