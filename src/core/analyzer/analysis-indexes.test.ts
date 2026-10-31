import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const {
  vectorBuild, textBuild, specBuild, readSourceCapped, resolveEmbedder, indexCapabilityAgreement, TestLockContendedError,
  backgroundSemanticAllowed, indexCarriesLocalVectors, localEmbed, readCurrentGeneration,
} = vi.hoisted(() => ({
  vectorBuild: vi.fn(), textBuild: vi.fn(), specBuild: vi.fn(), readSourceCapped: vi.fn(), resolveEmbedder: vi.fn(),
  indexCapabilityAgreement: vi.fn(),
  backgroundSemanticAllowed: vi.fn(), indexCarriesLocalVectors: vi.fn(), localEmbed: vi.fn(), readCurrentGeneration: vi.fn(),
  // Declared here, not at module scope: `vi.mock` factories are hoisted above every
  // top-level binding, so a class defined outside is still uninitialized when they run.
  TestLockContendedError: class TestLockContendedError extends Error {
    constructor(readonly lockPath: string, readonly holderPid: number | null, readonly ageMs: number) {
      super(`Vector index mutation lock is held by pid ${holderPid} (held for ${Math.round(ageMs / 1000)}s): ${lockPath}`);
      this.name = 'VectorIndexLockContendedError';
    }
  },
}));

vi.mock('./vector-index.js', () => ({
  VectorIndex: { build: vectorBuild, exists: vi.fn(() => true) },
  VectorIndexLockContendedError: TestLockContendedError,
}));
vi.mock('./text-line-index.js', () => ({ TextLineIndex: { build: textBuild, exists: vi.fn(() => true) } }));
vi.mock('./spec-vector-index.js', () => ({ SpecVectorIndex: { build: specBuild, exists: vi.fn(() => true) } }));
vi.mock('./embedder.js', () => ({
  resolveEmbedder, indexCapabilityAgreement, embedderMode: () => 'keyword',
  backgroundSemanticAllowed, indexCarriesLocalVectors, localEmbedderInstalled: () => true,
}));
vi.mock('./local-embedding-service.js', () => ({
  LocalEmbeddingService: Object.assign(vi.fn(function () { return { modelName: 'local:test-model', embed: localEmbed }; }), {
    shared: vi.fn(() => ({ modelName: 'local:test-model', embed: localEmbed })),
  }),
}));
vi.mock('../runtime/analysis-generation.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readCurrentGeneration,
}));
vi.mock('./file-walker.js', () => ({ FileWalker: vi.fn(function () { return { walk: vi.fn(async () => ({ files: [] })) }; }) }));
vi.mock('../../utils/command-helpers.js', () => ({ fileExists: vi.fn(async () => true) }));
vi.mock('./bounded-file-scan.js', () => ({
  mapFilesBounded: vi.fn(async (items: string[], operation: (item: string) => Promise<unknown>) => Promise.all(items.map(operation))),
  readSourceCapped,
}));

import { buildAnalysisIndexes, buildBackgroundLocalVectors } from './analysis-indexes.js';
import { FileWalker } from './file-walker.js';

// A root literal has to be resolved for the HOST platform, then composed with `join`.
// A bare "/repo" is not a fully-qualified Windows path, and the product's path
// confinement (`safeJoin`) rejects every child of it there, so the index build would
// be asserted against a root no read could ever pass.
const ROOT = resolve('/repo');
const OUTPUT = join(ROOT, '.openlore', 'analysis');

describe('shared analysis index builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vectorBuild.mockResolvedValue({ hasEmbeddings: false, total: 1, productionFunctions: 1, testFunctions: 0, signatureOnlySymbols: 0, reused: 0, embedded: 0 });
    textBuild.mockResolvedValue({ lines: 0, files: 0 });
    specBuild.mockResolvedValue({ recordCount: 1, hasEmbeddings: false });
    readSourceCapped.mockResolvedValue('export function f() {}');
    resolveEmbedder.mockResolvedValue(null);
    indexCapabilityAgreement.mockReturnValue({ agrees: true });
  });

  it('falls back to keyword indexes and discloses resolver failure', async () => {
    resolveEmbedder.mockRejectedValueOnce(new Error('endpoint unavailable'));
    const result = await buildAnalysisIndexes({
      rootPath: ROOT, outputPath: OUTPUT, config: null,
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
    });
    expect(vectorBuild.mock.calls[0][5]).toBeNull();
    expect(result.degraded).toEqual([expect.objectContaining({ index: 'function', reason: expect.stringContaining('endpoint unavailable') })]);
  });

  it('treats an empty OpenSpec directory as an expected skip for every frontend', async () => {
    specBuild.mockRejectedValueOnce(new Error('OpenSpec specs directory exists but contains no spec.md files'));
    const result = await buildAnalysisIndexes({
      rootPath: ROOT, outputPath: OUTPUT, config: null, keywordOnly: true,
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] } } as never,
    });
    expect(result.degraded).not.toContainEqual(expect.objectContaining({ index: 'spec' }));
  });

  it('indexes specs and decisions under the configured confined OpenSpec root', async () => {
    await buildAnalysisIndexes({
      rootPath: ROOT, outputPath: OUTPUT,
      config: { openspecPath: 'docs/specs' } as never, keywordOnly: true,
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] } } as never,
    });
    expect(specBuild).toHaveBeenCalledWith(
      OUTPUT, join(ROOT, 'docs', 'specs', 'specs'), null,
      join(OUTPUT, 'mapping.json'), join(ROOT, 'docs', 'specs', 'decisions'),
    );
  });

  it('builds function, literal-text, and spec keyword indexes from one shared entry point', async () => {
    const result = await buildAnalysisIndexes({
      rootPath: ROOT,
      outputPath: OUTPUT,
      config: null,
      keywordOnly: true,
      llmContext: {
        phase1_survey: { purpose: '', files: [] },
        phase2_deep: { purpose: '', files: [] },
        phase3_validation: { purpose: '', files: [] },
        callGraph: {
          nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }],
          edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [],
        },
      } as never,
    });
    expect(vectorBuild).toHaveBeenCalledOnce();
    expect(vectorBuild.mock.calls[0][5]).toBeNull();
    expect(readSourceCapped).toHaveBeenCalledWith(join(ROOT, 'src', 'f.ts'), expect.any(Number));
    expect(textBuild).toHaveBeenCalledOnce();
    expect(specBuild).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ functionIndex: 'built', textIndex: 'built', specIndex: 'built', degraded: [] });
  });

  it('propagates the effective analysis corpus to the literal-text walker', async () => {
    await buildAnalysisIndexes({
      rootPath: ROOT, outputPath: OUTPUT, keywordOnly: true,
      config: { analysis: { includePatterns: ['generated/keep.ts'], excludePatterns: ['private/**'] } } as never,
      include: ['vendor/keep.ts'], exclude: ['tmp/**'],
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] } } as never,
    });
    expect(FileWalker).toHaveBeenCalledWith(ROOT, {
      includePatterns: ['vendor/keep.ts'],
      restrictedIncludePatterns: ['generated/keep.ts'],
      excludePatterns: ['private/**', 'tmp/**'],
      protectedExcludePatterns: ['.openlore/analysis/**', 'openspec/**'],
    });
  });

  it('omits an oversized function body without skipping the symbol index', async () => {
    readSourceCapped.mockResolvedValue(null);
    await buildAnalysisIndexes({
      rootPath: ROOT, outputPath: OUTPUT, config: null, keywordOnly: true,
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/huge.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
    });
    expect(vectorBuild).toHaveBeenCalledOnce();
    expect((vectorBuild.mock.calls[0][6] as Map<string, string>).size).toBe(0);
  });

  it('drops call-graph file paths that escape the repository', async () => {
    await buildAnalysisIndexes({
      rootPath: ROOT, outputPath: OUTPUT, config: null, keywordOnly: true,
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: '../../secret.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
    });
    expect(readSourceCapped).not.toHaveBeenCalled();
    expect((vectorBuild.mock.calls[0][6] as Map<string, string>).size).toBe(0);
  });
  // skipIf(win32): creating a symlink there needs elevated privileges or Developer Mode,
  // so this cannot build the premise it asserts about and would test a plain file instead.
  // What it guards is platform-independent and is exercised on Linux.
  it.skipIf(process.platform === 'win32')('drops call-graph file symlinks that escape the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-index-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'openlore-index-outside-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n');
    await symlink(join(outside, 'secret.ts'), join(root, 'src', 'link.ts'));
    await buildAnalysisIndexes({
      rootPath: root, outputPath: join(root, '.openlore', 'analysis'), config: null, keywordOnly: true,
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/link.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
    });
    expect(readSourceCapped).not.toHaveBeenCalled();
  });

  it('serializes callers and reuses intact indexes bound to the same generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-index-generation-'));
    const outputPath = join(root, '.openlore', 'analysis');
    await mkdir(outputPath, { recursive: true });
    const options = {
      rootPath: root, outputPath, config: null, keywordOnly: true, generationId: 'generation-1',
      llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
    };
    try {
      await Promise.all([buildAnalysisIndexes(options), buildAnalysisIndexes(options)]);
      expect(vectorBuild).toHaveBeenCalledOnce();
      expect(textBuild).toHaveBeenCalledOnce();
      expect(specBuild).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // A receipt whose generation and configuration hash still match can sit over an index
  // that never realized the configured provider — the state this repository served for
  // days on 2026-09-20. Reuse has to compare the REALIZED capability too.
  describe('capability agreement gates index reuse', () => {
    async function buildTwice(
      agreement: { agrees: boolean; mismatch?: string },
      reports: Array<{ index: string; status: string; detail?: string }>,
    ): Promise<void> {
      const root = await mkdtemp(join(tmpdir(), 'openlore-index-capability-'));
      const outputPath = join(root, '.openlore', 'analysis');
      await mkdir(outputPath, { recursive: true });
      const options = {
        rootPath: root, outputPath, generationId: 'generation-1',
        config: { embedding: { baseUrl: 'http://localhost:8765/v1', model: 'all-MiniLM-L6-v2' } },
        reporter: { report: (event: { index: string; status: string; detail?: string }) => { reports.push(event); } },
        llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
      } as never;
      try {
        // First build writes the receipt; the second decides whether to reuse it.
        indexCapabilityAgreement.mockReturnValue({ agrees: true });
        await buildAnalysisIndexes(options);
        indexCapabilityAgreement.mockReturnValue(agreement);
        reports.length = 0;
        await buildAnalysisIndexes(options);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    it('rebuilds when a provider is configured but the index carries no vectors', async () => {
      const reports: Array<{ index: string; status: string; detail?: string }> = [];
      await buildTwice({ agrees: false, mismatch: 'configured-but-unrealized' }, reports);
      expect(vectorBuild).toHaveBeenCalledTimes(2);
      expect(reports).toContainEqual(expect.objectContaining({
        index: 'function', status: 'skip',
        detail: expect.stringContaining('configured but the existing index carries no vectors'),
      }));
    });

    it('rebuilds on the reverse mismatch: vectors with no configured provider', async () => {
      const reports: Array<{ index: string; status: string; detail?: string }> = [];
      await buildTwice({ agrees: false, mismatch: 'vectors-without-provider' }, reports);
      expect(vectorBuild).toHaveBeenCalledTimes(2);
      expect(reports).toContainEqual(expect.objectContaining({
        index: 'function', status: 'skip',
        detail: expect.stringContaining('no embedding provider is configured'),
      }));
    });

      it('never writes a keyword index over a build another process is running', async () => {
      // The 2026-09-20 shape: contention landed in the same catch as a provider failure,
      // so the collider wrote a keyword-only index and the command exited 0.
      const contended = new TestLockContendedError('/repo/.openlore/analysis/.vector-index.lock', 41624, 55_000);
      vectorBuild.mockRejectedValueOnce(contended);
      resolveEmbedder.mockResolvedValue({ modelName: 'all-MiniLM-L6-v2', embed: async () => [] });
      const reports: Array<{ index: string; status: string; detail?: string }> = [];

      const failure = await buildAnalysisIndexes({
        rootPath: ROOT, outputPath: OUTPUT,
        config: { embedding: { baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' } } as never,
        reporter: { report: event => { reports.push(event); } },
        llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
      }).catch((error: unknown) => error);

      expect(failure).toBe(contended);
      // Exactly one attempt: no keyword-only rebuild behind the holder's back.
      expect(vectorBuild).toHaveBeenCalledOnce();
      expect(reports).not.toContainEqual(expect.objectContaining({
        detail: expect.stringContaining('keyword index used'),
      }));
    });

    it('still falls back to keyword when the EMBEDDING PROVIDER is the failure', async () => {
      vectorBuild.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8765'));
      resolveEmbedder.mockResolvedValue({ modelName: 'all-MiniLM-L6-v2', embed: async () => [] });

      const result = await buildAnalysisIndexes({
        rootPath: ROOT, outputPath: OUTPUT,
        config: { embedding: { baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' } } as never,
        llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
      });

      expect(result.degraded).toEqual([expect.objectContaining({ reason: expect.stringContaining('ECONNREFUSED') })]);
      expect(vectorBuild).toHaveBeenCalledTimes(2);
    });

    it('asks the lock to wait only when the caller asked to wait', async () => {
      const options = {
        rootPath: ROOT, outputPath: OUTPUT, config: null, force: true,
        llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] }, callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] } } as never,
      };
      await buildAnalysisIndexes(options as never);
      expect(vectorBuild.mock.calls[0][10]).toMatchObject({ contention: 'report' });
      await buildAnalysisIndexes({ ...options, waitForLock: true } as never);
      expect(vectorBuild.mock.calls[1][10]).toMatchObject({ contention: 'wait' });
    });

  it('reuses an agreeing index and says nothing about capability', async () => {
      const reports: Array<{ index: string; status: string; detail?: string }> = [];
      await buildTwice({ agrees: true }, reports);
      expect(vectorBuild).toHaveBeenCalledOnce();
      expect(reports).not.toContainEqual(expect.objectContaining({
        detail: expect.stringContaining('index carries no vectors'),
      }));
    });

    it('does not consult capability at all for a keyword-only build', async () => {
      const root = await mkdtemp(join(tmpdir(), 'openlore-index-keyword-only-'));
      const outputPath = join(root, '.openlore', 'analysis');
      await mkdir(outputPath, { recursive: true });
      const options = {
        rootPath: root, outputPath, config: null, keywordOnly: true, generationId: 'generation-1',
        llmContext: { phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] } } as never,
      } as never;
      try {
        await buildAnalysisIndexes(options);
        indexCapabilityAgreement.mockClear();
        await buildAnalysisIndexes(options);
        expect(indexCapabilityAgreement).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

describe('background local vectors (change: enable-local-semantic-search-in-background)', () => {
  const graphContext = {
    phase1_survey: { purpose: '', files: [] }, phase2_deep: { purpose: '', files: [] }, phase3_validation: { purpose: '', files: [] },
    callGraph: { nodes: [{ id: 'f', name: 'f', filePath: 'src/f.ts' }], edges: [], stats: { totalNodes: 1, totalEdges: 0 }, hubFunctions: [], entryPoints: [] },
  };
  let root: string;
  let outputPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'openlore-background-vectors-'));
    outputPath = join(root, '.openlore', 'analysis');
    await mkdir(outputPath, { recursive: true });
    await writeFile(join(outputPath, 'llm-context.json'), JSON.stringify(graphContext));
    readSourceCapped.mockResolvedValue('export function f() {}');
    backgroundSemanticAllowed.mockReturnValue(true);
    indexCarriesLocalVectors.mockReturnValue(false);
    localEmbed.mockImplementation(async (texts: string[]) => texts.map(() => [0.5, 0.5]));
    readCurrentGeneration.mockResolvedValue({ generationId: 'generation-1' });
    // Each build embeds its records, as the real one does.
    vectorBuild.mockImplementation(async (_dir: string, _n: unknown, _s: unknown, _h: unknown, _e: unknown, embedder: { embed(t: string[]): Promise<number[][]> }) => {
      await embedder.embed(['record f']);
      return { hasEmbeddings: true };
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('embeds into a scratch index, then writes the real one from the recorded vectors', async () => {
    expect(await buildBackgroundLocalVectors(root, outputPath, null)).toBe('built');

    expect(vectorBuild).toHaveBeenCalledTimes(2);
    expect(vectorBuild.mock.calls[0][0]).not.toBe(outputPath);
    expect(vectorBuild.mock.calls[1][0]).toBe(outputPath);
    // The probe and the scratch build embed; the real write replays and embeds nothing.
    expect(localEmbed).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when the repository opted out', async () => {
    backgroundSemanticAllowed.mockReturnValue(false);
    expect(await buildBackgroundLocalVectors(root, outputPath, null)).toBe('skipped');
    expect(vectorBuild).not.toHaveBeenCalled();
  });

  it('stays silent and writes nothing when the model cannot load', async () => {
    localEmbed.mockRejectedValue(new Error('no network'));
    expect(await buildBackgroundLocalVectors(root, outputPath, null)).toBe('skipped');
    expect(vectorBuild).not.toHaveBeenCalled();
  });

  it('stands down while another live pass holds the repository claim', async () => {
    const runtime = join(root, '.openlore', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, 'background-vectors.lock'), `${process.pid} ${new Date().toISOString()}`);
    expect(await buildBackgroundLocalVectors(root, outputPath, null)).toBe('skipped');
    expect(vectorBuild).not.toHaveBeenCalled();
  });

  it('reclaims the claim of a pass that died', async () => {
    const runtime = join(root, '.openlore', 'runtime');
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, 'background-vectors.lock'), `999999999 ${new Date().toISOString()}`);
    expect(await buildBackgroundLocalVectors(root, outputPath, null)).toBe('built');
  });

  it('does not write while a full analysis owns the repository', async () => {
    const { acquireAnalysisOwnership } = await vi.importActual<typeof import('../runtime/analysis-ownership.js')>('../runtime/analysis-ownership.js');
    const held = await acquireAnalysisOwnership(root, outputPath);
    expect(held.state).toBe('owned');
    try {
      // This process owns it, but the pass asks as a separate owner and must be refused.
      expect(await buildBackgroundLocalVectors(root, outputPath, null)).toBe('skipped');
      expect(vectorBuild).toHaveBeenCalledTimes(1); // the scratch build only; the real index untouched
    } finally {
      if (held.state === 'owned') await held.release();
    }
  });

  it('leaves the real index alone when a newer generation was published meanwhile', async () => {
    readCurrentGeneration.mockResolvedValueOnce({ generationId: 'generation-1' }).mockResolvedValueOnce({ generationId: 'generation-2' });
    expect(await buildBackgroundLocalVectors(root, outputPath, null)).toBe('skipped');
    expect(vectorBuild).toHaveBeenCalledOnce();
    expect(vectorBuild.mock.calls[0][0]).not.toBe(outputPath);
  });
});
