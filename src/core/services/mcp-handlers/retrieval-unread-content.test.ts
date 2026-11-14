/**
 * The first call of every agent session must not claim coverage over content it could not read
 * (change: fix-retrieval-coverage-over-unread-content).
 *
 * The 2026-11-07 case: a repository with one good and two unparseable source files. `orient`
 * returned no functions, no files and no boundary; `search_code` returned
 * `coverage.verdict: "uncovered"`, reason "Nothing in the index matched this query." — while
 * `doctor`, reading the same index, reported "2 file(s) parsed with errors". A confident empty
 * answer is the most expensive possible failure on this path, because the agent stops looking.
 *
 * Each test below pins one of the five defects, and the two directions that matter: a degraded
 * repository must never read as covered, and a clean one must never read as degraded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MatchEvidence } from '../../analyzer/retrieval-evidence.js';
import type { FileParseHealth, ParseHealthReport } from '../../analyzer/parse-health.js';

const ANALYSIS = join('.openlore', 'analysis');

function makeRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a::src/good.ts',
    name: 'ok',
    filePath: 'src/good.ts',
    language: 'typescript',
    signature: '() => number',
    docstring: '',
    fanIn: 1,
    fanOut: 1,
    isHub: false,
    isEntryPoint: false,
    className: '',
    ...over,
  };
}

const strong: MatchEvidence = { field: 'symbol', terms: ['ok'], tier: 1 };

function parseHealth(files: FileParseHealth[], over: Partial<ParseHealthReport> = {}): ParseHealthReport {
  const regions = files.reduce((n, f) => n + f.errorCount + f.missingCount, 0);
  return {
    version: 1,
    totalDegradedFiles: files.length,
    totalErrorRegions: regions,
    byLanguage: [],
    topFiles: files,
    files,
    ...over,
  };
}

/** A file that parsed into NOTHING — the worst case, and the one a result-scoped boundary misses. */
const zeroSymbolFile: FileParseHealth = {
  filePath: 'src/broken.py',
  language: 'Python',
  errorCount: 2,
  missingCount: 1,
  errorLines: [1],
  parseFailed: true,
};

describe('orient / search_code — coverage over unread content', () => {
  let tmpDir: string;
  const savedEmbedEnv = { base: process.env.EMBED_BASE_URL, model: process.env.EMBED_MODEL };

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-unread-'));
    await mkdir(join(tmpDir, ANALYSIS), { recursive: true });
    await writeFile(join(tmpDir, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'anthropic', model: 'claude-sonnet-5' },
      createdAt: '2026-11-07T00:00:00.000Z',
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

  const writeParseHealth = async (report: ParseHealthReport | string): Promise<void> => {
    await writeFile(
      join(tmpDir, ANALYSIS, 'parse-health.json'),
      typeof report === 'string' ? report : JSON.stringify(report),
      'utf-8',
    );
  };

  // ── Defect 1: unparseable files ───────────────────────────────────────────

  it('does not report "nothing matched" over files it could not parse', async () => {
    await writeParseHealth(parseHealth([zeroSymbolFile, {
      filePath: 'src/broken.ts', language: 'TypeScript', errorCount: 1, missingCount: 0, errorLines: [1],
    }]));
    mockSearch([]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'bad') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.verdict).toBe('partial');
    expect(coverage.evidenceVerdict).toBe('uncovered');
    expect(coverage.reason).toContain('could not be read');
    expect((coverage.unreadable as Record<string, unknown>).causes)
      .toEqual(expect.arrayContaining(['parse-errors', 'parse-failed']));
  });

  it('discloses a file that produced ZERO symbols, which no result set can surface', async () => {
    // The structural trap: the pre-existing boundary is scoped to the files a result SURFACED, so
    // a file that contributed nothing is invisible to it by construction.
    await writeParseHealth(parseHealth([zeroSymbolFile]));
    mockSearch([{ score: 2, scoreKind: 'bm25', record: makeRecord(), matchEvidence: strong }]);
    const { handleOrient } = await import('./orient.js');

    const result = await handleOrient(tmpDir, 'bad') as Record<string, unknown>;

    expect(result.relevantFiles).toEqual(['src/good.ts']); // broken.py never surfaces
    expect(result.parseHealth).toContain('src/broken.py');
    expect((result.coverage as Record<string, unknown>).verdict).toBe('partial');
  });

  it('survives a repository where EVERY file is unparseable', async () => {
    const all = Array.from({ length: 50 }, (_, i): FileParseHealth => ({
      filePath: `src/f${i}.ts`, language: 'TypeScript', errorCount: 3, missingCount: 0,
      errorLines: [1], parseFailed: true,
    }));
    await writeParseHealth(parseHealth(all));
    mockSearch([]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'anything') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.verdict).toBe('partial');
    expect((coverage.unreadable as Record<string, unknown>).excludedFiles).toBe(50);
  });

  it('stays bounded on a large repository with a single bad file', async () => {
    const files = [zeroSymbolFile];
    await writeParseHealth(parseHealth(files));
    mockSearch(Array.from({ length: 10 }, (_, i) => ({
      score: 2, scoreKind: 'bm25', record: makeRecord({ id: `f${i}::src/f${i}.ts`, filePath: `src/f${i}.ts` }),
      matchEvidence: strong,
    })));
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'ok') as Record<string, unknown>;

    // One bad file does not make a 10,000-file repository uncovered — it makes it partial.
    expect((result.coverage as Record<string, unknown>).verdict).toBe('partial');
    expect((result.results as unknown[]).length).toBe(10);
  });

  // ── Defect 2: an index that cannot be vouched for ─────────────────────────

  it('refuses an unattested index with the SAME conclusion the graph tools emit', async () => {
    // A published generation whose artifact no longer hashes to it: the exact state
    // `get_subgraph` / `blast_radius` / `select_tests` / `find_dead_code` already refuse.
    await writeFile(join(tmpDir, ANALYSIS, 'llm-context.json'), '{"phase1_survey":{"files":[]}}', 'utf-8');
    await writeFile(join(tmpDir, ANALYSIS, 'dependency-graph.json'), '{}', 'utf-8');
    await writeFile(join(tmpDir, ANALYSIS, 'repo-structure.json'), '{}', 'utf-8');
    await writeFile(join(tmpDir, ANALYSIS, 'fingerprint.json'), '{}', 'utf-8');
    await writeFile(join(tmpDir, ANALYSIS, 'generation.json'), JSON.stringify({
      version: 1,
      generationId: 'gen-deadbeef',
      publishedAt: '2026-11-07T00:00:00.000Z',
      compatibility: 'manifest',
      coherence: 'full',
      // A digest that does not match the artifact on disk: a lost publish, exactly the state
      // the graph tools refuse rather than serve unverified bytes from.
      artifacts: [
        { path: 'llm-context.json', sha256: '0'.repeat(64), bytes: 1 },
        { path: 'dependency-graph.json', sha256: '0'.repeat(64), bytes: 1 },
        { path: 'repo-structure.json', sha256: '0'.repeat(64), bytes: 1 },
        { path: 'fingerprint.json', sha256: '0'.repeat(64), bytes: 1 },
      ],
    }), 'utf-8');
    mockSearch([{ score: 2, scoreKind: 'bm25', record: makeRecord(), matchEvidence: strong }]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'ok') as Record<string, unknown>;

    expect(result.notReady).toBe(true);
    expect(result.reason).toBe('index-generation-mismatch');
    expect(result.remedy).toBe('openlore analyze');
    expect(result.coverage).toBeUndefined();
  });

  // ── Defect 3: a file too large to read ────────────────────────────────────

  it('names a size-capped file as a cause rather than ranking around it', async () => {
    await writeParseHealth(parseHealth([{
      filePath: 'schema/huge.graphql', language: 'GraphQL', errorCount: 0, missingCount: 0,
      errorLines: [], exclusion: 'size-cap',
    }], { excludedByReason: { 'size-cap': 1 } }));
    mockSearch([{ score: 2, scoreKind: 'bm25', record: makeRecord(), matchEvidence: strong }]);
    const { handleOrient } = await import('./orient.js');

    const result = await handleOrient(tmpDir, 'add a GraphQL type') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.verdict).toBe('partial');
    expect((coverage.unreadable as Record<string, unknown>).causes).toContain('size-cap');
    expect(result.parseHealth).toContain('schema/huge.graphql');
  });

  // ── Defect 5: the silent cap ──────────────────────────────────────────────

  it('discloses the clamp and the bound instead of silently cutting the page', async () => {
    mockSearch(Array.from({ length: 100 }, (_, i) => ({
      score: 2, scoreKind: 'bm25',
      record: makeRecord({ id: `f${i}::src/f${i}.ts`, filePath: `src/f${i}.ts` }),
      matchEvidence: strong,
    })));
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'ok', 200) as Record<string, unknown>;

    const composition = result.composition as Record<string, unknown>;
    expect(composition.requestedLimit).toBe(200);
    expect(composition.servedLimit).toBe(100);
    expect(composition.limitClamped).toContain('clamped to 100');
    expect(composition.moreMayExist).toBe(true);
    expect(composition.matched).toBe(100);
    expect(composition.returned).toBe(100);
  });

  it('does not claim a clamp, or hidden matches, on a page that fits', async () => {
    mockSearch([{ score: 2, scoreKind: 'bm25', record: makeRecord(), matchEvidence: strong }]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'ok', 10) as Record<string, unknown>;

    const composition = result.composition as Record<string, unknown>;
    expect(composition.limitClamped).toBeUndefined();
    expect(composition.moreMayExist).toBe(false);
    expect(composition.matched).toBe(1);
    expect(composition.omitted).toBe(0);
  });

  // ── The other direction: a clean repository is not degraded ───────────────

  it('leaves a clean repository fully covered, with no boundary and no shortfall', async () => {
    mockSearch([{ score: 2, scoreKind: 'bm25', record: makeRecord(), matchEvidence: strong }]);
    const { handleSearchCode } = await import('./semantic.js');
    const { handleOrient } = await import('./orient.js');

    const search = await handleSearchCode(tmpDir, 'ok') as Record<string, unknown>;
    const orient = await handleOrient(tmpDir, 'ok') as Record<string, unknown>;

    expect(search.coverage).toEqual({ verdict: 'covered', questionKind: 'where-is' });
    expect(search.parseHealth).toBeUndefined();
    expect(orient.coverage).toEqual({ verdict: 'covered', questionKind: 'where-is' });
    expect(orient.parseHealth).toBeUndefined();
  });

  it('still abstains honestly on a clean repository where nothing matched', async () => {
    mockSearch([]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'no such thing') as Record<string, unknown>;

    expect((result.coverage as Record<string, unknown>).verdict).toBe('uncovered');
  });

  // ── The disclosure's own record ───────────────────────────────────────────

  it('discloses a malformed parse-health record instead of reading it as a clean repository', async () => {
    await writeParseHealth('{ this is not json');
    mockSearch([{ score: 2, scoreKind: 'bm25', record: makeRecord(), matchEvidence: strong }]);
    const { handleSearchCode } = await import('./semantic.js');

    const result = await handleSearchCode(tmpDir, 'ok') as Record<string, unknown>;

    const coverage = result.coverage as Record<string, unknown>;
    expect(coverage.verdict).toBe('partial');
    expect((coverage.unreadable as Record<string, unknown>).causes).toEqual(['health-record-unreadable']);
  });

  it('treats a truncated parse-health record as unreadable, never as nothing-degraded', async () => {
    await writeParseHealth('{"version":1,"totalDegradedFiles":2,"fil');
    mockSearch([]);
    const { handleOrient } = await import('./orient.js');

    const result = await handleOrient(tmpDir, 'bad') as Record<string, unknown>;

    expect((result.coverage as Record<string, unknown>).verdict).toBe('partial');
    expect(result.parseHealth).toContain('could not be read');
  });

  it('reads an ABSENT parse-health record as the clean repository it means', async () => {
    mockSearch([{ score: 2, scoreKind: 'bm25', record: makeRecord(), matchEvidence: strong }]);
    const { handleOrient } = await import('./orient.js');

    const result = await handleOrient(tmpDir, 'ok') as Record<string, unknown>;

    expect((result.coverage as Record<string, unknown>).verdict).toBe('covered');
  });
});
