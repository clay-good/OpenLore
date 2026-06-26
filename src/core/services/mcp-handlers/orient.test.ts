/**
 * Tests for handleOrient
 *
 * Strategy:
 *  - Mock validateDirectory to skip filesystem checks.
 *  - Mock VectorIndex / EmbeddingService / SpecVectorIndex via vi.mock so dynamic
 *    imports resolve to lightweight stubs.
 *  - Mock utils helpers (loadMappingIndex, readCachedContext, …).
 *  - Mock semantic helpers (classifyRole, deriveStrategy, …) with simple return values.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Static mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
  loadMappingIndex: vi.fn(async () => null),
  specsForFile: vi.fn(() => []),
  functionsForDomain: vi.fn(() => []),
  readCachedContext: vi.fn(async () => null),
  isCacheFresh: vi.fn(async () => false),
  queryTooLongError: vi.fn(() => null),
  safeJoin: vi.fn((dir: string, p: string) => `${dir}/${p}`),
}));

vi.mock('../config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(async () => null),
}));

vi.mock('./semantic.js', () => ({
  classifyRole: vi.fn(() => 'orchestrator'),
  deriveStrategy: vi.fn(() => 'wrap'),
  compositeScore: vi.fn((score: number) => score),
  buildReason: vi.fn(() => 'test reason'),
}));

vi.mock('../../analyzer/vector-index.js', () => ({
  VectorIndex: {
    exists: vi.fn(() => false),
    search: vi.fn(async () => []),
  },
}));

vi.mock('../../analyzer/embedding-service.js', () => ({
  EmbeddingService: {
    fromEnv: vi.fn(() => { throw new Error('no env'); }),
    fromConfig: vi.fn(() => null),
  },
}));

vi.mock('../../analyzer/spec-vector-index.js', () => ({
  SpecVectorIndex: {
    exists: vi.fn(() => false),
    search: vi.fn(async () => []),
  },
}));

vi.mock('../../decisions/store.js', () => ({
  loadDecisionStore: vi.fn(async () => ({
    version: '1',
    sessionId: 'test-session',
    updatedAt: '2026-01-01T00:00:00.000Z',
    decisions: [],
  })),
  INACTIVE_STATUSES: new Set(['rejected', 'synced', 'phantom']),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { handleOrient } from './orient.js';
import { VectorIndex } from '../../analyzer/vector-index.js';
import { EmbeddingService } from '../../analyzer/embedding-service.js';
import { SpecVectorIndex } from '../../analyzer/spec-vector-index.js';
import { loadMappingIndex, specsForFile, functionsForDomain, readCachedContext } from './utils.js';
import { readOpenLoreConfig } from '../config-manager.js';
import { loadDecisionStore } from '../../decisions/store.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStyleFingerprint } from '../../analyzer/style-fingerprint.js';
import { ARTIFACT_STYLE_FINGERPRINT } from '../../../constants.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSearchResult(overrides: Partial<{
  id: string; name: string; filePath: string; fanIn: number; fanOut: number;
}> = {}) {
  return {
    score: 0.2,
    record: {
      id: overrides.id ?? 'src/foo.ts::doFoo',
      name: overrides.name ?? 'doFoo',
      filePath: overrides.filePath ?? 'src/foo.ts',
      signature: 'function doFoo(): void',
      docstring: 'Does foo',
      language: 'TypeScript',
      fanIn: overrides.fanIn ?? 2,
      fanOut: overrides.fanOut ?? 3,
      isHub: false,
      isEntryPoint: false,
      text: '',
      className: '',
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleOrient', () => {
  beforeEach(() => {
    vi.mocked(VectorIndex.exists).mockReturnValue(false);
    vi.mocked(VectorIndex.search).mockResolvedValue([]);
    vi.mocked(SpecVectorIndex.exists).mockReturnValue(false);
    vi.mocked(SpecVectorIndex.search).mockResolvedValue([]);
    vi.mocked(loadMappingIndex).mockResolvedValue(null);
    vi.mocked(readCachedContext).mockResolvedValue(null);
    vi.mocked(specsForFile).mockReturnValue([]);
    vi.mocked(functionsForDomain).mockReturnValue([]);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null);
    vi.mocked(EmbeddingService.fromEnv).mockImplementation(() => { throw new Error('no env'); });
    vi.mocked(EmbeddingService.fromConfig).mockReturnValue(null);
    vi.mocked(loadDecisionStore).mockResolvedValue({
      version: '1',
      sessionId: 'test-session',
      updatedAt: '2026-01-01T00:00:00.000Z',
      decisions: [],
    });
  });

  it('returns error when no code index exists', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(false);
    const result = await handleOrient('/tmp/proj', 'find auth handler') as Record<string, unknown>;
    expect(result.error).toContain('No analysis found');
    expect(result.hint).toBeDefined();
  });

  it('returns orient structure when code index exists and search returns results', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'handleAuth', filePath: 'src/auth.ts' }),
      makeSearchResult({ name: 'verifyToken', filePath: 'src/auth.ts' }),
    ]);

    const result = await handleOrient('/tmp/proj', 'auth handler', 2) as Record<string, unknown>;

    expect(result.task).toBe('auth handler');
    expect(result.searchMode).toBe('bm25_fallback'); // EmbeddingService.fromEnv throws → bm25
    expect(Array.isArray(result.relevantFiles)).toBe(true);
    expect(Array.isArray(result.relevantFunctions)).toBe(true);
    expect(Array.isArray(result.callPaths)).toBe(true);
    expect(Array.isArray(result.insertionPoints)).toBe(true);
    expect(Array.isArray(result.nextSteps)).toBe(true);
    expect((result.relevantFunctions as unknown[]).length).toBeGreaterThan(0);
  });

  // regionStyle PRODUCER (change: add-codebase-style-fingerprint). The renderer is covered in
  // orient-inject.test.ts; this exercises the producer in handleOrient end-to-end: it reads the
  // persisted fingerprint, picks the dominant supported language of the matched functions, resolves
  // the region of the top file, and attaches a bounded dominant-idioms summary.
  async function seedFingerprintDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'orient-style-'));
    const ad = join(dir, '.openlore', 'analysis');
    await mkdir(ad, { recursive: true });
    const raw = [{
      filePath: 'src/auth.ts',
      language: 'TypeScript',
      counters: { binding: { const: 30, let: 2 }, functionForm: { arrow: 14, declaration: 6 } },
      functionsSampled: 20,
    }];
    const nodes = [{ filePath: 'src/auth.ts', communityId: 'c1', communityLabel: 'Auth' }];
    await writeFile(join(ad, ARTIFACT_STYLE_FINGERPRINT), JSON.stringify(buildStyleFingerprint(raw, nodes)));
    return dir;
  }

  it('produces a regionStyle summary for the touched region from the persisted fingerprint', async () => {
    const dir = await seedFingerprintDir();
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult({ name: 'handleAuth', filePath: 'src/auth.ts' })]);
    try {
      const result = await handleOrient(dir, 'auth handler', 5) as {
        regionStyle?: { scope: string; language: string; communityId?: string; dominantIdioms: string[] };
      };
      expect(result.regionStyle, 'handleOrient should populate regionStyle').toBeDefined();
      expect(result.regionStyle!.language).toBe('TypeScript');
      expect(result.regionStyle!.scope).toBe('region'); // src/auth.ts is attributed to community c1
      expect(result.regionStyle!.communityId).toBe('c1');
      expect(result.regionStyle!.dominantIdioms.length).toBeGreaterThan(0);
      expect(result.regionStyle!.dominantIdioms.some(s => s.startsWith('binding=const'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omits regionStyle in lean mode even when a fingerprint exists', async () => {
    const dir = await seedFingerprintDir();
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult({ name: 'handleAuth', filePath: 'src/auth.ts' })]);
    try {
      const lean = await handleOrient(dir, 'auth handler', 5, undefined, true) as Record<string, unknown>;
      expect(lean.regionStyle).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lean mode (Spec 27) returns the navigation core only and drops enrichment', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'handleAuth', filePath: 'src/auth.ts' }),
      makeSearchResult({ name: 'verifyToken', filePath: 'src/auth.ts' }),
    ]);

    const lean = await handleOrient('/tmp/proj', 'who calls handleAuth', 5, undefined, true) as Record<string, unknown>;

    // Core kept, with expand handles on every function (the progressive-disclosure contract).
    expect(lean.lean).toBe(true);
    expect(Array.isArray(lean.relevantFunctions)).toBe(true);
    expect(Array.isArray(lean.callPaths)).toBe(true);
    expect(lean.specDomains).toBeDefined();
    for (const f of lean.relevantFunctions as Array<{ expand?: string }>) {
      expect(typeof f.expand).toBe('string');
    }
    // Enrichment dropped — each is reachable via expand handles / dedicated tools.
    for (const k of ['insertionPoints', 'nextSteps', 'provenance', 'changeCoupling', 'inlineSpecs', 'architectureViolations']) {
      expect(lean[k], `lean should omit "${k}"`).toBeUndefined();
    }

    // And lean is materially smaller than the rich payload for the same query.
    const rich = await handleOrient('/tmp/proj', 'who calls handleAuth', 5) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(lean))).toBeLessThan(Buffer.byteLength(JSON.stringify(rich)));
  });

  it('full mode surfaces task-scoped landmarks (labeled, proximity-ordered); lean omits them', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'seedFn', filePath: 'src/a.ts', id: 'src/a.ts::seedFn' }),
    ]);
    const mk = (id: string, fanIn: number, fanOut: number) => ({
      id, name: id.split('::')[1], filePath: id.split('::')[0], isAsync: false, language: 'typescript',
      startIndex: 0, endIndex: 1, fanIn, fanOut, isExternal: false, isTest: false,
    });
    const seed = mk('src/a.ts::seedFn', 1, 1);
    const hub = mk('src/a.ts::hubFn', 40, 2); // hub → chokepoint, one hop from the seed
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: {
        nodes: [seed, hub],
        edges: [{ callerId: seed.id, calleeId: hub.id, calleeName: 'hubFn', confidence: 'import', kind: 'calls' }],
        classes: [], inheritanceEdges: [], hubFunctions: [hub], entryPoints: [], layerViolations: [],
        stats: { totalNodes: 2, totalEdges: 1, avgFanIn: 0, avgFanOut: 0 },
      },
    } as never);

    const full = await handleOrient('/tmp/proj', 'work on seedFn', 5, undefined, false) as {
      landmarks?: Array<{ name: string; distance: number; hops: number; signals: Array<{ label: string }> }>;
    };
    const lean = await handleOrient('/tmp/proj', 'work on seedFn', 5, undefined, true) as Record<string, unknown>;

    expect(Array.isArray(full.landmarks)).toBe(true);
    const hubLm = full.landmarks!.find(l => l.name === 'hubFn');
    expect(hubLm).toBeDefined();
    expect(hubLm!.signals.map(s => s.label)).toContain('hub');
    expect(typeof hubLm!.distance).toBe('number');
    expect(typeof hubLm!.hops).toBe('number');
    expect(full.landmarks!.find(l => l.name === 'seedFn')).toBeUndefined(); // the matched seed is not its own landmark
    expect('landmarks' in lean).toBe(false); // lean omits the enrichment
  });

  it('opt-in pagerank mode reorders landmarks by connectivity; default ordering is unchanged', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'seedFn', filePath: 'src/a.ts', id: 'src/a.ts::seedFn' }),
    ]);
    const mk = (id: string, fanIn: number, fanOut: number) => ({
      id, name: id.split('::')[1], filePath: id.split('::')[0], isAsync: false, language: 'typescript',
      startIndex: 0, endIndex: 1, fanIn, fanOut, isExternal: false, isTest: false,
    });
    const seed = mk('src/a.ts::seedFn', 1, 4);
    // Two hubs, BOTH one hop (distance 1) from the seed. `zHub` is additionally reachable
    // by two more independent routes (seed→m1→zHub, seed→m2→zHub); `aHub` by one route.
    // Distance ranking ties them and breaks on id (aHub first). PageRank, measuring
    // connectivity, ranks the many-routes hub (zHub) first — so the order flips.
    const aHub = mk('src/a.ts::aHub', 40, 2);
    const zHub = mk('src/a.ts::zHub', 40, 2);
    const m1 = mk('src/a.ts::m1', 1, 1);
    const m2 = mk('src/a.ts::m2', 1, 1);
    const callGraph = {
      nodes: [seed, aHub, zHub, m1, m2],
      edges: [
        { callerId: seed.id, calleeId: aHub.id, calleeName: 'aHub', confidence: 'import', kind: 'calls' },
        { callerId: seed.id, calleeId: zHub.id, calleeName: 'zHub', confidence: 'import', kind: 'calls' },
        { callerId: seed.id, calleeId: m1.id, calleeName: 'm1', confidence: 'import', kind: 'calls' },
        { callerId: seed.id, calleeId: m2.id, calleeName: 'm2', confidence: 'import', kind: 'calls' },
        { callerId: m1.id, calleeId: zHub.id, calleeName: 'zHub', confidence: 'import', kind: 'calls' },
        { callerId: m2.id, calleeId: zHub.id, calleeName: 'zHub', confidence: 'import', kind: 'calls' },
      ],
      classes: [], inheritanceEdges: [], hubFunctions: [aHub, zHub], entryPoints: [], layerViolations: [],
      stats: { totalNodes: 5, totalEdges: 6, avgFanIn: 0, avgFanOut: 0 },
    };
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph } as never);

    type Lm = { name: string; relevance?: number };
    const distance = await handleOrient('/tmp/proj', 'work on seedFn', 5, undefined, false, 'distance') as { landmarks?: Lm[] };
    const pagerank = await handleOrient('/tmp/proj', 'work on seedFn', 5, undefined, false, 'pagerank') as { landmarks?: Lm[] };
    const omitted = await handleOrient('/tmp/proj', 'work on seedFn', 5, undefined, false) as { landmarks?: Lm[] };

    // Default (distance) ordering: id tie-break puts aHub before zHub, and carries no relevance.
    const distNames = distance.landmarks!.map(l => l.name);
    expect(distNames.indexOf('aHub')).toBeLessThan(distNames.indexOf('zHub'));
    expect(distance.landmarks!.every(l => l.relevance === undefined)).toBe(true);
    // rankBy omitted is byte-identical to rankBy:'distance' (default unchanged).
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(distance));

    // PageRank ordering: the better-connected hub comes first, and relevance is attached.
    const prNames = pagerank.landmarks!.map(l => l.name);
    expect(prNames.indexOf('zHub')).toBeLessThan(prNames.indexOf('aHub'));
    expect(pagerank.landmarks!.find(l => l.name === 'zHub')!.relevance).toBeGreaterThan(
      pagerank.landmarks!.find(l => l.name === 'aHub')!.relevance!,
    );
  });

  it('suggests the navigation tools by task intent (find_path / get_map)', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult({ name: 'doFoo', filePath: 'src/foo.ts' })]);

    const route = await handleOrient('/p', 'how does the request route reach the db writer', 3) as { suggestedTools: string[] };
    expect(route.suggestedTools).toContain('find_path');

    const map = await handleOrient('/p', 'give me an overview of the architecture and how modules connect', 3) as { suggestedTools: string[] };
    expect(map.suggestedTools).toContain('get_map');
  });

  it('lean mode skips the enrichment WORK, not just the payload (Spec 27 deepened)', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'handleAuth', filePath: 'src/auth.ts' }),
    ]);

    // The decision-store load is one of the enrichment side-effects lean must avoid:
    // rich computes it (then surfaces pendingDecisions), lean must not even read it.
    vi.mocked(loadDecisionStore).mockClear();
    await handleOrient('/tmp/proj', 'who calls handleAuth', 5, undefined, true);
    expect(loadDecisionStore, 'lean must not load the decision store').not.toHaveBeenCalled();

    vi.mocked(loadDecisionStore).mockClear();
    await handleOrient('/tmp/proj', 'who calls handleAuth', 5);
    expect(loadDecisionStore, 'rich still loads the decision store').toHaveBeenCalled();
  });

  it('preserves raw score (higher = better) without inverting via 1 - score', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'topResult', filePath: 'src/top.ts' }),
    ]);

    const result = await handleOrient('/tmp/proj', 'test task') as Record<string, unknown>;
    const fns = result.relevantFunctions as Array<{ score: number; name: string }>;
    expect(fns.length).toBe(1);
    // Raw score from mock is 0.2 — should be preserved, NOT inverted to 0.8
    expect(fns[0].score).toBe(0.2);
  });

  it('returns empty collections when search returns no results', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([]);

    const result = await handleOrient('/tmp/proj', 'unknown task') as Record<string, unknown>;

    expect(result.relevantFunctions).toEqual([]);
    expect(result.relevantFiles).toEqual([]);
    expect(result.callPaths).toEqual([]);
    expect(result.insertionPoints).toEqual([]);
    expect(Array.isArray(result.nextSteps)).toBe(true);
  });

  it('uses embed service from config when env service is unavailable', async () => {
    vi.mocked(EmbeddingService.fromConfig).mockReturnValue({ model: 'config-model' } as never);
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ version: '1.0' } as never); // non-null cfg
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    // When fromConfig returns a service, searchMode should be 'hybrid' (not bm25_fallback)
    expect(result.searchMode).toBe('hybrid');
    expect(result.note).toBeUndefined();
  });

  it('includes specLinkedFunctions from cross-graph spec traversal', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ id: 'src/auth.ts::login', name: 'login', filePath: 'src/auth.ts' }),
    ]);
    vi.mocked(loadMappingIndex).mockResolvedValue({ domains: {}, files: {} } as never);
    // Seed function has linkedSpecs in a domain
    vi.mocked(specsForFile).mockReturnValue([
      { requirement: 'Login', domain: 'auth', specFile: 'openspec/specs/auth/spec.md' },
    ]);
    // functionsForDomain returns a peer in a DIFFERENT file (not in seed file set)
    vi.mocked(functionsForDomain).mockReturnValue([
      { name: 'logout', file: 'src/session.ts', line: 0, kind: 'function', confidence: 'high', requirement: 'Logout' },
    ]);

    const result = await handleOrient('/tmp/proj', 'login task') as Record<string, unknown>;

    expect(result.specLinkedFunctions).toBeDefined();
    const linked = result.specLinkedFunctions as Array<{ name: string; filePath: string }>;
    expect(linked.some(f => f.name === 'logout')).toBe(true);
  });

  it('states the first-class keyword mode (no degraded warning) when no embedder is configured', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    expect(result.searchMode).toBe('bm25_fallback');
    expect(result.retrievalMode).toBe('keyword');
    expect(typeof result.note).toBe('string');
    // Honest, low-noise: name the mode + offer the upgrade, never warn about a
    // "fallback" or an "unavailable" server for the plain default.
    expect(result.note as string).toContain('Keyword (BM25)');
    expect(result.note as string).toContain('embed --local');
    expect(result.note as string).not.toContain('unavailable');
  });

  it('includes specDomains when mapping index provides file-to-spec data', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ filePath: 'src/auth.ts' }),
    ]);
    vi.mocked(loadMappingIndex).mockResolvedValue({ domains: {}, files: {} } as never);
    vi.mocked(specsForFile).mockReturnValue([
      { requirement: 'Auth flow', domain: 'auth', specFile: 'openspec/specs/auth/spec.md' },
    ]);

    const result = await handleOrient('/tmp/proj', 'auth') as Record<string, unknown>;

    expect(Array.isArray(result.specDomains)).toBe(true);
    const domains = result.specDomains as Array<{ domain: string }>;
    expect(domains.some(d => d.domain === 'auth')).toBe(true);
  });

  it('includes call paths derived from call graph context', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    const searchResult = makeSearchResult({ id: 'src/foo.ts::doFoo', name: 'doFoo', filePath: 'src/foo.ts' });
    vi.mocked(VectorIndex.search).mockResolvedValue([searchResult]);
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: {
        nodes: [
          { id: 'src/foo.ts::doFoo', name: 'doFoo', filePath: 'src/foo.ts', fanIn: 1, fanOut: 1, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 100 },
          { id: 'src/bar.ts::doBar', name: 'doBar', filePath: 'src/bar.ts', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 50 },
        ],
        edges: [
          { callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'name_only' },
        ],
        classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
        stats: { totalNodes: 2, totalEdges: 1, avgFanIn: 0.5, avgFanOut: 0.5 },
      },
      edgeStore: {
        getCallers: (id: string) => id === 'src/bar.ts::doBar'
          ? [{ callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'name_only' }]
          : [],
        getCallees: (id: string) => id === 'src/foo.ts::doFoo'
          ? [{ callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'name_only' }]
          : [],
        getNode: (id: string) => id === 'src/bar.ts::doBar'
          ? { id: 'src/bar.ts::doBar', name: 'doBar', filePath: 'src/bar.ts', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 50 }
          : null,
      },
    } as never);

    const result = await handleOrient('/tmp/proj', 'foo task') as Record<string, unknown>;
    const callPaths = result.callPaths as Array<{ function: string; callees: unknown[] }>;

    expect(callPaths.length).toBeGreaterThan(0);
    const fooPath = callPaths.find(p => p.function === 'doFoo');
    expect(fooPath).toBeDefined();
    expect(fooPath!.callees.length).toBeGreaterThan(0);
  });

  it('surfaces local provenance (last author + PR) for relevant files (spec-18)', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ id: 'src/foo.ts::doFoo', name: 'doFoo', filePath: 'src/foo.ts' }),
    ]);
    vi.mocked(readCachedContext).mockResolvedValue({
      edgeStore: {
        getCallers: () => [],
        getCallees: () => [],
        getNode: () => null,
        getDecisionsForFiles: () => [],
        getProvenanceForFiles: (files: string[]) =>
          files.some(f => f.endsWith('src/foo.ts'))
            ? [{
                filePath: 'src/foo.ts',
                lastAuthor: { name: 'Bob', email: 'bob@example.com' },
                lastDate: '2026-02-01T10:00:00Z', lastCommit: 'abc1234', lastSubject: 'fix (#42)',
                recentAuthors: [{ name: 'Bob', email: 'bob@example.com' }],
                prs: [{ number: 42, title: 'Fix the bucket' }],
              }]
            : [],
      },
    } as never);

    const result = await handleOrient('/tmp/proj', 'foo task') as Record<string, unknown>;
    const prov = result.provenance as Array<{ file: string; lastAuthor: string; lastPr?: number; lastPrTitle?: string }>;
    expect(prov).toBeDefined();
    expect(prov[0]).toMatchObject({ file: 'src/foo.ts', lastAuthor: 'Bob', lastPr: 42, lastPrTitle: 'Fix the bucket' });
  });

  it('omits provenance when the edge store has no provenance for the files (spec-18)', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);
    vi.mocked(readCachedContext).mockResolvedValue({
      edgeStore: {
        getCallers: () => [], getCallees: () => [], getNode: () => null,
        getDecisionsForFiles: () => [], getProvenanceForFiles: () => [],
      },
    } as never);
    const result = await handleOrient('/tmp/proj', 'foo task') as Record<string, unknown>;
    expect(result.provenance).toBeUndefined();
  });

  it('includes matchingSpecs when spec index and embed service are available', async () => {
    vi.mocked(EmbeddingService.fromEnv).mockReturnValue({ model: 'test' } as never);
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(SpecVectorIndex.exists).mockReturnValue(true);
    vi.mocked(SpecVectorIndex.search).mockResolvedValue([{
      score: 0.1,
      record: { domain: 'auth', section: '## Auth Flow', title: 'Authentication', text: 'Auth text here', id: 'auth::1' },
    } as never]);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);

    const result = await handleOrient('/tmp/proj', 'auth') as Record<string, unknown>;

    expect(result.matchingSpecs).toBeDefined();
    const specs = result.matchingSpecs as Array<{ domain: string }>;
    expect(specs[0].domain).toBe('auth');
  });

  it('filters out external synthetic nodes from relevantFunctions', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'realFn', filePath: 'src/real.ts' }),
      { score: 0.5, record: { ...makeSearchResult().record, id: 'external::fetch', name: 'fetch', filePath: 'external' } },
      { score: 0.4, record: { ...makeSearchResult().record, id: 'external::https.request', name: 'https.request', filePath: 'src/real.ts' } },
    ]);

    const result = await handleOrient('/tmp/proj', 'fetch task') as Record<string, unknown>;
    const fns = result.relevantFunctions as Array<{ name: string; filePath: string }>;

    expect(fns.some(f => f.filePath === 'external')).toBe(false);
    expect(fns.some(f => f.name === 'fetch')).toBe(false);
    // The node with id starting with 'external::' is also filtered even if filePath differs
    expect(fns.some(f => f.name === 'https.request')).toBe(false);
  });

  it('includes pendingDecisions when active decisions exist', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);
    vi.mocked(loadDecisionStore).mockResolvedValue({
      version: '1',
      sessionId: 'test-session',
      updatedAt: '2026-01-01T00:00:00.000Z',
      decisions: [
        {
          id: 'abc12345',
          status: 'approved',
          title: 'Use SQLite',
          rationale: 'JSON too big',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: ['services'],
          affectedFiles: [],
          sessionId: 'test-session',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'medium',
          syncedToSpecs: [],
        },
        {
          id: 'def67890',
          status: 'synced', // excluded — synced decisions are not active
          title: 'Already synced',
          rationale: 'Done',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: [],
          affectedFiles: [],
          sessionId: 'test-session',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'medium',
          syncedToSpecs: ['services'],
        },
      ],
    });

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    expect(result.pendingDecisions).toBeDefined();
    const decisions = result.pendingDecisions as Array<{ id: string; status: string }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe('abc12345');
    expect(decisions[0].status).toBe('approved');
  });

  it('omits pendingDecisions when all decisions are synced or rejected', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);
    vi.mocked(loadDecisionStore).mockResolvedValue({
      version: '1',
      sessionId: 'test-session',
      updatedAt: '2026-01-01T00:00:00.000Z',
      decisions: [
        {
          id: 'aaa11111',
          status: 'synced',
          title: 'Done',
          rationale: 'r',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: [],
          affectedFiles: [],
          sessionId: 's',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'low',
          syncedToSpecs: [],
        },
        {
          id: 'bbb22222',
          status: 'rejected',
          title: 'Bad',
          rationale: 'r',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: [],
          affectedFiles: [],
          sessionId: 's',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'low',
          syncedToSpecs: [],
        },
      ],
    });

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    expect(result.pendingDecisions).toBeUndefined();
  });

  it('omits external callee neighbours from call paths', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    const searchResult = makeSearchResult({ id: 'src/foo.ts::doFoo', name: 'doFoo', filePath: 'src/foo.ts' });
    vi.mocked(VectorIndex.search).mockResolvedValue([searchResult]);
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: { nodes: [], edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [], stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } },
      edgeStore: {
        getCallers: () => [],
        getCallees: () => [
          { callerId: 'src/foo.ts::doFoo', calleeId: 'external::fetch', calleeName: 'fetch', confidence: 'name_only' },
          { callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'exact' },
        ],
        getNode: (id: string) => {
          if (id === 'external::fetch') return { id, name: 'fetch', filePath: 'external', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 0, isExternal: true };
          if (id === 'src/bar.ts::doBar') return { id, name: 'doBar', filePath: 'src/bar.ts', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 50 };
          return null;
        },
      },
    } as never);

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;
    const callPaths = result.callPaths as Array<{ function: string; callees: Array<{ name: string }> }>;
    const fooPaths = callPaths.find(p => p.function === 'doFoo');

    expect(fooPaths).toBeDefined();
    // External node (fetch) must be filtered out; internal doBar kept
    expect(fooPaths!.callees.some(c => c.name === 'fetch')).toBe(false);
    expect(fooPaths!.callees.some(c => c.name === 'doBar')).toBe(true);
  });
});
