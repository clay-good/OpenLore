/**
 * MCP handler tests — analysis.ts
 *
 * Tests the read-from-cache / static-transform handlers without running the
 * heavy analysis pipeline or making real LLM calls.
 *
 * Strategy:
 *  - Mock validateDirectory to return the temp dir directly.
 *  - Write real JSON fixture files to a temp dir so readFile / stat work
 *    against the same code path used in production.
 *  - Mock runAnalysis (used by handleAnalyzeCodebase) to avoid executing the
 *    full analysis pipeline in unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_MAPPING,
  ARTIFACT_REPO_STRUCTURE,
  ARTIFACT_ROUTE_INVENTORY,
  ARTIFACT_MIDDLEWARE_INVENTORY,
  ARTIFACT_SCHEMA_INVENTORY,
  ARTIFACT_UI_INVENTORY,
  ARTIFACT_ENV_INVENTORY,
  ARTIFACT_EXTERNAL_PACKAGES,
} from '../../../constants.js';

// ============================================================================
// MODULE MOCKS
// ============================================================================

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    validateDirectory: vi.fn(async (dir: string) => dir),
    readCachedContext: vi.fn(async () => null),
    isCacheFresh: vi.fn(async () => false),
  };
});

vi.mock('../../../cli/commands/analyze.js', () => ({
  runAnalysis: vi.fn(),
}));

// ============================================================================
// HELPERS
// ============================================================================

async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openlore-analysis-test-'));
}

async function writeAnalysisFile(rootPath: string, filename: string, content: unknown): Promise<void> {
  const dir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), JSON.stringify(content), 'utf-8');
}

function makeMinimalDepGraph() {
  return {
    nodes: [], edges: [], clusters: [], structuralClusters: [], cycles: [],
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    statistics: { nodeCount: 5, edgeCount: 3, importEdgeCount: 2, httpEdgeCount: 1, avgDegree: 1, density: 0.1, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0 },
  };
}

function makeMinimalLLMContext() {
  return {
    phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
    phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
  };
}

// ============================================================================
// handleGetArchitectureOverview
// ============================================================================

describe('handleGetArchitectureOverview', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
    readCachedContext.mockResolvedValue(null);
  });

  it('returns error when no dep graph and no cached context', async () => {
    // no files written → readFile will throw ENOENT, readCachedContext returns null
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('returns overview when dep graph exists (no ctx)', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, makeMinimalDepGraph());
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as Record<string, unknown>;
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('clusters');
    expect(result).toHaveProperty('globalEntryPoints');
    expect(result).toHaveProperty('criticalHubs');
  });

  it('returns overview when only cached context exists (no dep graph)', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as Record<string, unknown>;
    expect(result).toHaveProperty('summary');
  });

  it('summary totalFiles matches dep graph nodeCount', async () => {
    const graph = makeMinimalDepGraph();
    graph.statistics.nodeCount = 42;
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, graph);
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as { summary: { totalFiles: number } };
    expect(result.summary.totalFiles).toBe(42);
  });

  it('exposes the shared deterministic domain evidence for MCP hosts', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, makeMinimalDepGraph());
    await writeAnalysisFile(tmpDir, ARTIFACT_REPO_STRUCTURE, {
      domains: [{
        name: 'billing',
        files: ['src/billing/model.ts', 'src/billing/routes.ts', 'src/billing/model.test.ts'],
        definingFiles: ['src/billing/model.ts', 'src/billing/routes.ts'],
        supportingFiles: ['src/billing/model.test.ts'],
      }],
      domainDecisions: [{
        candidate: 'routes', path: 'src/billing/routes', sources: ['dependency-cluster'],
        disposition: 'merged', reason: 'contained-footprint', owner: 'billing', files: ['src/billing/routes.ts'],
      }],
      undomained: [],
      schemas: [{ file: 'src/billing/model.ts', name: 'Invoice' }],
      routeInventory: { routes: [{ file: 'src/billing/routes.ts', method: 'GET', path: '/invoices' }] },
    });
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [{ path: 'src/billing/model.ts', functions: [] }, { path: 'src/billing/routes.ts', functions: [] }],
    });
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as { domainEvidence: Array<{ name: string; schemaFiles: string[]; apiFiles: string[]; definingFiles: string[]; supportingFiles: string[]; candidateDecisions: unknown[] }> };
    expect(result.domainEvidence).toEqual([expect.objectContaining({
      name: 'billing',
      schemaFiles: ['src/billing/model.ts'],
      apiFiles: ['src/billing/routes.ts'],
      definingFiles: ['src/billing/model.ts', 'src/billing/routes.ts'],
      supportingFiles: ['src/billing/model.test.ts'],
      candidateDecisions: [expect.objectContaining({ candidate: 'routes', owner: 'billing' })],
    })]);
  });
});

// ============================================================================
// handleGetRefactorReport
// ============================================================================

describe('handleGetRefactorReport', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no cached context', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('returns error when cached context has no callGraph', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as { error: string };
    expect(result.error).toContain('Call graph not available');
  });

  it('returns refactor report when callGraph is present', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      callGraph: {
        nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [],
        stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
      },
    });
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as Record<string, unknown>;
    // analyzeForRefactoring returns an object with a priorities array
    expect(result).toHaveProperty('priorities');
    expect(Array.isArray(result.priorities)).toBe(true);
  });
});

// ============================================================================
// handleGetDuplicateReport
// ============================================================================

describe('handleGetDuplicateReport', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns error when duplicates.json does not exist', async () => {
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as { error: string };
    expect(result.error).toContain('No duplicate report found');
  });

  it('returns error when duplicates.json is malformed JSON', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'duplicates.json'), 'not-json', 'utf-8');
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as { error: string };
    expect(result.error).toContain('corrupted');
  });

  it('returns an unrecognized-shape report unchanged (fail-soft) under either format', async () => {
    const payload = { groups: [{ files: ['a.ts', 'b.ts'], similarity: 0.9 }] };
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'duplicates.json'), JSON.stringify(payload), 'utf-8');
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as typeof payload;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].similarity).toBe(0.9);
  });

  // ConciseByDefaultDetailedOnRequest: a real { cloneGroups, stats } report.
  function makeReport(groupCount: number) {
    const cloneGroups = Array.from({ length: groupCount }, (_, i) => ({
      type: 'exact',
      similarity: 1,
      lineCount: groupCount - i, // descending, so order is observable
      instances: [{ file: `a${i}.ts`, name: `fn${i}` }, { file: `b${i}.ts`, name: `fn${i}` }],
    }));
    return { cloneGroups, stats: { totalFunctions: 100, duplicatedFunctions: groupCount * 2, duplicationRatio: 0.1, cloneGroupCount: groupCount } };
  }

  async function writeReport(report: unknown): Promise<void> {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'duplicates.json'), JSON.stringify(report), 'utf-8');
  }

  it('defaults to a concise summary (stats + top groups), not the full report', async () => {
    await writeReport(makeReport(3));
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as {
      responseFormat: string; totalCloneGroups: number; topGroups: unknown[]; stats: { cloneGroupCount: number }; cloneGroups?: unknown;
    };
    expect(result.responseFormat).toBe('concise');
    expect(result.totalCloneGroups).toBe(3);
    expect(result.topGroups).toHaveLength(3);
    expect(result.stats.cloneGroupCount).toBe(3);
    // Concise omits the full per-instance group array.
    expect(result.cloneGroups).toBeUndefined();
  });

  it('returns the full report unchanged with responseFormat:"detailed"', async () => {
    const report = makeReport(3);
    await writeReport(report);
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir, 'detailed') as typeof report;
    expect(result.cloneGroups).toHaveLength(3);
    expect(result.cloneGroups[0].instances).toHaveLength(2);
  });

  it('carries a truncation receipt when concise drops clone groups', async () => {
    await writeReport(makeReport(15)); // > the 10-group concise cap
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as {
      topGroups: unknown[]; truncation?: { omitted: number; detail: string };
    };
    expect(result.topGroups).toHaveLength(10);
    expect(result.truncation?.omitted).toBe(5);
    expect(result.truncation?.detail).toMatch(/detailed/);
  });

  it('treats an unknown responseFormat value as concise (never silently detailed)', async () => {
    await writeReport(makeReport(2));
    const { handleGetDuplicateReport } = await import('./analysis.js');
    // @ts-expect-error — exercising the runtime normalization of a bad value
    const result = await handleGetDuplicateReport(tmpDir, 'verbose') as { responseFormat?: string };
    expect(result.responseFormat).toBe('concise');
  });
});

// ============================================================================
// handleGetSignatures
// ============================================================================

describe('handleGetSignatures', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error message when no cached context', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(result).toContain('No analysis found');
  });

  it('returns error message when context has no signatures', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(result).toContain('No signatures available');
  });

  it('returns formatted signatures when available', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [{ kind: 'function', name: 'login', signature: 'login(username: string): Promise<User>' }] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('filters signatures by filePattern', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [{ kind: 'function', name: 'login', signature: 'login(): void' }] },
        { path: 'src/user.ts', entries: [{ kind: 'function', name: 'getUser', signature: 'getUser(): void' }] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir, 'auth');
    // Should only include auth.ts content, not user.ts
    expect(result).toContain('auth');
    // login function appears in auth.ts
    expect(result).toContain('login');
  });

  it('returns no-match message when filePattern matches nothing', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir, 'nonexistent');
    expect(result).toContain('No files matching');
  });
});

// ============================================================================
// handleGetMapping
// ============================================================================

describe('handleGetMapping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  /** A graph plus specs is all the link index needs; `mapping.json` is a cache. */
  async function seed(specs: Record<string, string>): Promise<void> {
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, {
      nodes: [
        { file: { path: 'src/auth.ts' }, exports: [
          { name: 'login', kind: 'function', line: 1, isType: false },
          { name: 'hashPassword', kind: 'function', line: 9, isType: false },
        ] },
        { file: { path: 'src/user.ts' }, exports: [{ name: 'getUser', kind: 'function', line: 1, isType: false }] },
        { file: { path: 'src/util.ts' }, exports: [{ name: 'internalHelper', kind: 'function', line: 1, isType: false }] },
      ],
      edges: [], clusters: [], structuralClusters: [], rankings: {}, cycles: [], statistics: {},
    });
    for (const [domain, content] of Object.entries(specs)) {
      await mkdir(join(tmpDir, 'openspec', 'specs', domain), { recursive: true });
      await writeFile(join(tmpDir, 'openspec', 'specs', domain, 'spec.md'), content);
    }
  }

  const requirement = (name: string, anchor: string): string =>
    `### Requirement: ${name}\n\nThe system SHALL work.\n- **Implementation**: \`${anchor}\`\n\n`;

  it('reports an input it cannot resolve against, not a missing cache', async () => {
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir) as { error: string; reason: string };
    expect(result.reason).toBe('analysis-unavailable');
    expect(result.error).toContain('openlore analyze');
  });

  it('derives links with no mapping.json present at all', async () => {
    await seed({
      auth: `# Auth\n\n${requirement('Logs In', 'login::src/auth.ts')}`,
      user: `# User\n\n${requirement('Reads A User', 'getUser::src/user.ts')}`,
    });
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir) as {
      source: string; mappings: unknown[]; orphanFunctions: Array<{ name: string }>;
    };
    expect(result.source).toBe('derived');
    expect(result.mappings).toHaveLength(2);
    expect(result.orphanFunctions.map(fn => fn.name).sort()).toEqual(['hashPassword', 'internalHelper']);
  });

  it('filters links by domain and withholds global orphans', async () => {
    await seed({
      auth: `# Auth\n\n${requirement('Logs In', 'login::src/auth.ts')}`,
      user: `# User\n\n${requirement('Reads A User', 'getUser::src/user.ts')}`,
    });
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, 'auth') as {
      mappings: Array<{ domain: string }>; orphanFunctions: unknown[];
    };
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0].domain).toBe('auth');
    expect(result.orphanFunctions).toHaveLength(0);
  });

  it('returns only orphans when orphansOnly is set', async () => {
    await seed({ auth: `# Auth\n\n${requirement('Logs In', 'login::src/auth.ts')}` });
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, undefined, true) as { orphanFunctions: unknown[] };
    expect(result.orphanFunctions).toHaveLength(3);
    expect(result).not.toHaveProperty('mappings');
  });

  it('filters orphans by path substring when orphansOnly and domain are set', async () => {
    await seed({ auth: `# Auth\n\n${requirement('Logs In', 'login::src/auth.ts')}` });
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, 'auth', true) as { orphanFunctions: Array<{ file: string }> };
    expect(result.orphanFunctions.every(fn => fn.file.includes('auth'))).toBe(true);
  });

  it('refuses a legacy probabilistic artifact and re-derives instead', async () => {
    await seed({ auth: `# Auth\n\n${requirement('Logs In', 'login::src/auth.ts')}` });
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, {
      version: 2, generatedAt: '2026-03-12T00:00:00.000Z', sourceAnalysisFingerprint: 'stale',
      mappings: [{ requirement: 'Invented', domain: 'auth', functions: [{ name: 'internalHelper', file: 'src/util.ts', confidence: 'heuristic' }] }],
      orphanFunctions: [], stats: {},
    });
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir) as { source: string; mappings: Array<{ requirement: string }> };
    expect(result.source).toBe('derived');
    expect(result.mappings.map(m => m.requirement)).toEqual(['Logs In']);
  });
});

// ============================================================================
// handleGetFunctionSkeleton
// ============================================================================

describe('handleGetFunctionSkeleton', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns error when file does not exist', async () => {
    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'nonexistent.ts') as { error: string };
    expect(result.error).toContain('File not found');
  });

  it('returns skeleton metadata for an existing TypeScript file', async () => {
    const src = `
// This is a comment
export function add(a: number, b: number): number {
  // implementation
  const x = a + b;
  return x;
}
`.trim();
    await writeFile(join(tmpDir, 'add.ts'), src, 'utf-8');

    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'add.ts') as {
      filePath: string;
      language: string;
      originalLines: number;
      skeletonLines: number;
      reductionPct: number;
      worthIncluding: boolean;
      skeleton: string;
    };

    expect(result.filePath).toBe('add.ts');
    expect(result.language).toBe('TypeScript');
    expect(result.originalLines).toBeGreaterThan(0);
    expect(result.skeleton).toBeDefined();
    expect(typeof result.reductionPct).toBe('number');
    expect(typeof result.worthIncluding).toBe('boolean');
  });

  it('returns originalLines and skeletonLines as positive integers', async () => {
    await writeFile(join(tmpDir, 'sample.ts'), 'export const x = 1;\n', 'utf-8');
    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'sample.ts') as { originalLines: number; skeletonLines: number };
    expect(Number.isInteger(result.originalLines)).toBe(true);
    expect(Number.isInteger(result.skeletonLines)).toBe(true);
    expect(result.originalLines).toBeGreaterThan(0);
    expect(result.skeletonLines).toBeGreaterThan(0);
  });
});

// ============================================================================
// handleAnalyzeCodebase — cached path only
// ============================================================================

describe('handleAnalyzeCodebase (cached path)', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;
  let isCacheFresh: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
    isCacheFresh = vi.mocked(utils.isCacheFresh);
  });

  it('returns cached result when cache is fresh and has context', async () => {
    isCacheFresh.mockResolvedValue(true);
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      callGraph: {
        nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [],
        stats: { totalNodes: 3, totalEdges: 2, avgFanIn: 0.5, avgFanOut: 0.7 },
      },
    });
    const { handleAnalyzeCodebase } = await import('./analysis.js');
    const result = await handleAnalyzeCodebase(tmpDir, false) as { cached: boolean; callGraph: Record<string, unknown> };
    expect(result.cached).toBe(true);
    expect(result.callGraph?.totalNodes).toBe(3);
  });

  it('returns cached: true with null callGraph when cached context has no callGraph', async () => {
    isCacheFresh.mockResolvedValue(true);
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleAnalyzeCodebase } = await import('./analysis.js');
    const result = await handleAnalyzeCodebase(tmpDir, false) as { cached: boolean; callGraph: null };
    expect(result.cached).toBe(true);
    expect(result.callGraph).toBeNull();
  });

  it('bypasses cache when force=true', async () => {
    isCacheFresh.mockResolvedValue(true);
    const { runAnalysis } = await import('../../../cli/commands/analyze.js');
    const mockRunAnalysis = vi.mocked(runAnalysis);
    mockRunAnalysis.mockResolvedValue({
      repoMap: {
        summary: { totalFiles: 10, analyzedFiles: 10 },
        allFiles: [], highValueFiles: [], lowPriorityFiles: [],
      },
      depGraph: makeMinimalDepGraph(),
      artifacts: {
        repoStructure: {
          projectName: 'test', projectType: 'node', frameworks: [], architecture: { pattern: 'layered' },
          domains: [], apiEndpoints: [], dataModels: [], summary: '',
        },
        llmContext: { ...makeMinimalLLMContext(), callGraph: undefined },
      },
      duration: 0,
    } as never);

    const { handleAnalyzeCodebase } = await import('./analysis.js');
    await handleAnalyzeCodebase(tmpDir, true);
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// handleGetFunctionBody
// ============================================================================

describe('handleGetFunctionBody', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
    readCachedContext.mockResolvedValue(null);
  });

  async function focusedFixture(language = 'TypeScript', baselineHash: string | null = null) {
    const src = `export function calculate(input: number): number {\n  const total = input + 1;\n  send(total);\n  return total;\n}\n`;
    await writeFile(join(tmpDir, 'calc.ts'), src, 'utf-8');
    const node = {
      id: 'calc.ts::calculate', name: 'calculate', filePath: 'calc.ts', language,
      startIndex: 0, endIndex: src.length, startLine: 1, endLine: 5,
    };
    await writeAnalysisFile(tmpDir, ARTIFACT_LLM_CONTEXT, { callGraph: { nodes: [node] } });
    const cfg = {
      blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
      edges: [{ from: 0, to: 1, kind: 'normal' }],
      params: ['input'], paramLine: 1,
      defUse: [
        { variable: 'input', defLine: 1, useLine: 2, precision: 'exact' },
        { variable: 'total', defLine: 2, useLine: 3, precision: 'may' },
        { variable: 'total', defLine: 2, useLine: 4, precision: 'exact' },
      ],
    };
    const edgeStore = {
      getFileHash: vi.fn(() => baselineHash),
      getCfg: vi.fn(() => cfg),
      getCallees: vi.fn(() => [{
        callerId: node.id, calleeId: 'external::send', calleeName: 'send', line: 3, confidence: 'external',
      }]),
    };
    readCachedContext.mockResolvedValue({
      callGraph: { nodes: [node], edges: [] }, edgeStore, artifactMtimeMs: Date.now() + 60_000,
    });
    return { src, node, cfg, edgeStore };
  }

  it('returns error when file does not exist', async () => {
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'nonexistent.ts', 'myFn') as { error: string };
    expect(result.error).toContain('File not found');
  });

  it('returns function body via line scan fallback when no call graph', async () => {
    const src = `export function doSomething(x: number): number {\n  return x + 1;\n}\n`;
    const srcPath = join(tmpDir, 'util.ts');
    await writeFile(srcPath, src, 'utf-8');

    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'util.ts', 'doSomething') as Record<string, unknown>;

    expect(result.functionName).toBe('doSomething');
    expect(result.filePath).toBe('util.ts');
    expect(typeof result.body).toBe('string');
    expect((result.body as string)).toContain('doSomething');
    expect(result.note).toContain('line scan');
    expect(result).toEqual({
      functionName: 'doSomething', filePath: 'util.ts', language: 'TypeScript', className: null,
      startLine: 1, endLine: 3, body: src.trimEnd(), lineCount: 3,
      note: 'Extracted via line scan (no call graph available). Run analyze_codebase for exact extraction.',
      provenance: expect.stringContaining('Untrusted repository source content'),
    });
  });

  it('returns error when function not found in file', async () => {
    const src = `export function otherFn() {}\n`;
    await writeFile(join(tmpDir, 'a.ts'), src, 'utf-8');

    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'a.ts', 'missingFn') as { error: string };
    expect(result.error).toContain('"missingFn"');
  });

  it('returns a sorted precision-preserving variable slice without the full body', async () => {
    await focusedFixture();
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;

    expect(result.body).toBeUndefined();
    expect(result.variableScope).toBe('same-spelling variables within this function');
    expect(result.slice).toEqual([
      { line: 2, text: '  const total = input + 1;', dataFlowPrecision: 'may', roles: ['definition'] },
      { line: 3, text: '  send(total);', dataFlowPrecision: 'may', roles: ['use'] },
      { line: 4, text: '  return total;', dataFlowPrecision: 'exact', roles: ['use'] },
    ]);
  });

  it('returns stored callee call sites without fabricating data-flow precision', async () => {
    const { edgeStore } = await focusedFixture();
    edgeStore.getCallees.mockReturnValue([
      { callerId: 'calc.ts::calculate', calleeId: 'external::send', calleeName: 'send', line: 3, confidence: 'external' },
      { callerId: 'calc.ts::calculate', calleeId: 'external::send', calleeName: 'send', line: 4, confidence: 'name_only' },
    ]);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'send', 'callee') as Record<string, unknown>;
    expect(result.slice).toEqual([
      { line: 3, text: '  send(total);', callConfidence: ['external'] },
      { line: 4, text: '  return total;', callConfidence: ['name_only'] },
    ]);
    for (const line of result.slice as Array<Record<string, unknown>>) {
      expect(line).not.toHaveProperty('dataFlowPrecision');
    }
  });

  it('requires focusKind for every focused read and honors it on a collision', async () => {
    const { edgeStore } = await focusedFixture();
    edgeStore.getCallees.mockReturnValue([{ callerId: 'calc.ts::calculate', calleeId: 'external::total', calleeName: 'total', line: 3, confidence: 'name_only' }]);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const ambiguous = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total') as Record<string, unknown>;
    expect(ambiguous.error).toContain('explicit focusKind');
    const callee = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'callee') as Record<string, unknown>;
    expect(callee.slice).toEqual([{ line: 3, text: '  send(total);', callConfidence: ['name_only'] }]);
  });

  it('serves callee evidence for a language without a CFG implementation', async () => {
    await focusedFixture('Bicep');
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'send', 'callee') as Record<string, unknown>;
    expect(result.slice).toEqual([{ line: 3, text: '  send(total);', callConfidence: ['external'] }]);
  });

  it('discloses a matching callee whose stored edge has no line', async () => {
    const { edgeStore } = await focusedFixture();
    edgeStore.getCallees.mockReturnValue([{ callerId: 'calc.ts::calculate', calleeId: 'external::send', calleeName: 'send', confidence: 'external' }] as never);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'send', 'callee') as Record<string, unknown>;
    expect(result.slice).toBeUndefined();
    expect(result.sliceUnavailable).toMatchObject({ reason: 'call-site-line-unavailable' });
  });

  it('refuses evidence outside the fresh indexed function span', async () => {
    const { edgeStore } = await focusedFixture();
    edgeStore.getCallees.mockReturnValue([{ callerId: 'calc.ts::calculate', calleeId: 'external::send', calleeName: 'send', line: 99, confidence: 'external' }]);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'send', 'callee') as Record<string, unknown>;
    expect(result.slice).toBeUndefined();
    expect(result.body).toBeUndefined();
    expect(result.sliceUnavailable).toMatchObject({ reason: 'artifact-invalid' });
  });

  it('fails closed on a malformed CFG artifact', async () => {
    const { edgeStore } = await focusedFixture();
    edgeStore.getCfg.mockReturnValue({ defUse: [{ variable: 'total', defLine: 2, useLine: 3, precision: 'bogus' }] } as never);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;
    expect(result.slice).toBeUndefined();
    expect(result.sliceUnavailable).toMatchObject({ reason: 'artifact-invalid' });
  });

  it('distinguishes a tracked but unused parameter from an unknown spelling', async () => {
    const { edgeStore } = await focusedFixture();
    edgeStore.getCfg.mockReturnValue({
      blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
      edges: [{ from: 0, to: 1, kind: 'normal' }], params: ['unused'], paramLine: 1, defUse: [],
    });
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'unused', 'variable') as Record<string, unknown>;
    expect(result.sliceUnavailable).toMatchObject({ reason: 'focus-has-no-evidence', candidates: ['send', 'unused'] });
  });

  it('refuses ambiguous same-file symbol records rather than picking one', async () => {
    const { node, edgeStore } = await focusedFixture();
    readCachedContext.mockResolvedValue({
      callGraph: { nodes: [node, { ...node, id: 'calc.ts::calculate#2', startIndex: 1 }], edges: [] }, edgeStore,
    } as never);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;
    expect(result.verdict).toBe('ambiguous');
    expect(result.sliceUnavailable).toMatchObject({ reason: 'ambiguous-symbol' });
  });

  it('does not apply a same-basename vendor symbol to the requested root file', async () => {
    const { node, edgeStore } = await focusedFixture();
    readCachedContext.mockResolvedValue({
      callGraph: { nodes: [{ ...node, id: 'vendor/calc.ts::calculate', filePath: 'vendor/calc.ts' }], edges: [] }, edgeStore,
    } as never);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;
    expect(result.verdict).toBe('not-found');
    expect(result.sliceUnavailable).toMatchObject({ reason: 'symbol-not-indexed' });
  });

  it('bounds malformed class and candidate metadata from persisted artifacts', async () => {
    const { node, edgeStore } = await focusedFixture();
    readCachedContext.mockResolvedValue({
      callGraph: { nodes: [{ ...node, className: 'x'.repeat(1_000_000) }], edges: [] }, edgeStore,
    } as never);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const invalidNode = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;
    expect(invalidNode.sliceUnavailable).toMatchObject({ reason: 'symbol-not-indexed' });
    expect(JSON.stringify(invalidNode).length).toBeLessThan(1_000);

    edgeStore.getCallees.mockReturnValue([{ callerId: node.id, calleeId: 'external::huge', calleeName: 'y'.repeat(1_000_000), line: 3, confidence: 'external' }] as never);
    readCachedContext.mockResolvedValue({ callGraph: { nodes: [node], edges: [] }, edgeStore, artifactMtimeMs: Date.now() + 60_000 } as never);
    const invalidCandidate = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'missing', 'variable') as Record<string, unknown>;
    expect(JSON.stringify(invalidCandidate)).not.toContain('yyyyyyyy');
    expect(JSON.stringify(invalidCandidate).length).toBeLessThan(2_000);
  });

  it('refuses focused completeness from a degraded analysis store', async () => {
    const { node, edgeStore } = await focusedFixture();
    readCachedContext.mockResolvedValue({
      callGraph: { nodes: [node], edges: [] }, edgeStore,
      integrity: { verdict: 'degraded', detail: 'row counts differ' },
    } as never);
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;
    expect(result.body).toBeUndefined();
    expect(result.sliceUnavailable).toMatchObject({ reason: 'index-integrity-degraded' });
  });

  it('uses the fresh indexed span, not brace scanning, for missing-overlay degradation', async () => {
    const src = 'def calculate(value):\n    text = "{ not a block }"\n    return value\n\ndef adjacent():\n    return "secret-adjacent"\n';
    const endIndex = src.indexOf('\n\ndef adjacent');
    await writeFile(join(tmpDir, 'calc.py'), src, 'utf-8');
    const node = { id: 'calc.py::calculate', name: 'calculate', filePath: 'calc.py', language: 'Python', startIndex: 0, endIndex, startLine: 1, endLine: 3 };
    readCachedContext.mockResolvedValue({
      callGraph: { nodes: [node], edges: [] }, artifactMtimeMs: Date.now() + 60_000,
      edgeStore: { getFileHash: vi.fn(() => null), getCfg: vi.fn(() => null), getCallees: vi.fn(() => []) },
    });
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.py', 'calculate', 'value', 'variable') as Record<string, unknown>;
    expect(result.body).toBe(src.slice(0, endIndex));
    expect(result.body).not.toContain('secret-adjacent');
    expect(result.sliceUnavailable).toMatchObject({ reason: 'overlay-unavailable' });
  });

  it('bounds a large focused slice and reports omitted evidence', async () => {
    const bodyLines = ['export function large(value: number) {',
      ...Array.from({ length: 60 }, (_, index) => `  value += ${index};`), '}'];
    const src = bodyLines.join('\n');
    await writeFile(join(tmpDir, 'large.ts'), src, 'utf-8');
    const node = {
      id: 'large.ts::large', name: 'large', filePath: 'large.ts', language: 'TypeScript',
      startIndex: 0, endIndex: src.length, startLine: 1, endLine: 62,
    };
    readCachedContext.mockResolvedValue({
      callGraph: { nodes: [node], edges: [] }, artifactMtimeMs: Date.now() + 60_000,
      edgeStore: {
        getFileHash: vi.fn(() => null),
        getCallees: vi.fn(() => []),
        getCfg: vi.fn(() => ({
          blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
          edges: [{ from: 0, to: 1, kind: 'normal' }], params: ['value'], paramLine: 1,
          defUse: Array.from({ length: 60 }, (_, index) => ({
            variable: 'value', defLine: index + 1, useLine: index + 2, precision: 'exact',
          })),
        })),
      },
    });
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'large.ts', 'large', 'value', 'variable') as Record<string, unknown>;
    expect(result.body).toBeUndefined();
    expect(result.slice).toHaveLength(50);
    expect(result.evidenceReceipt).toEqual({ total: 61, returned: 50, omitted: 11, limit: 50, truncated: true });
    expect(JSON.stringify(result).length).toBeLessThan(6_000);
  });

  it('returns the whole span with a machine-readable boundary for an unsupported language', async () => {
    await focusedFixture('Bicep');
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;
    expect(result.body).toContain('calculate');
    expect(result.sliceUnavailable).toMatchObject({ reason: 'unsupported-language', language: 'Bicep' });
  });

  it('refuses indexed lines when the authoritative source hash is stale', async () => {
    await focusedFixture('TypeScript', 'definitely-not-the-current-hash');
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'total', 'variable') as Record<string, unknown>;
    expect(result.body).toBeUndefined();
    expect(result.sliceUnavailable).toMatchObject({ reason: 'stale-index' });
    expect(result.slice).toBeUndefined();
  });

  it('returns exact stored candidates for an unknown focus instead of guessing', async () => {
    await focusedFixture();
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'calc.ts', 'calculate', 'missing', 'variable') as Record<string, unknown>;
    expect(result.verdict).toBe('not-found');
    expect(result.sliceUnavailable).toMatchObject({
      reason: 'focus-not-tracked', candidates: ['input', 'send', 'total'],
    });
  });
});

// ============================================================================
// handleGetRouteInventory
// ============================================================================

describe('handleGetRouteInventory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns cached: true + inventory data when route-inventory.json exists and is valid JSON', async () => {
    const payload = {
      total: 3,
      byMethod: { GET: 2, POST: 1 },
      byFramework: { express: 3 },
      routes: [
        { method: 'GET', path: '/users', framework: 'express', file: 'routes/users.ts', handler: 'getUsers' },
        { method: 'GET', path: '/users/:id', framework: 'express', file: 'routes/users.ts', handler: 'getUser' },
        { method: 'POST', path: '/users', framework: 'express', file: 'routes/users.ts', handler: 'createUser' },
      ],
    };
    await writeAnalysisFile(tmpDir, ARTIFACT_ROUTE_INVENTORY, payload);

    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    expect(result.cached).toBe(true);
    expect(result.total).toBe(3);
    expect(result.byMethod).toEqual({ GET: 2, POST: 1 });
    expect(result.byFramework).toEqual({ express: 3 });
    expect(Array.isArray(result.routes)).toBe(true);
  });

  it('falls back to live extraction (cached: false) when artifact file is absent', async () => {
    // No artifact written — live extraction runs against empty tmpDir
    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    expect(result.cached).toBe(false);
    // Structure should have the expected inventory fields
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('byMethod');
    expect(result).toHaveProperty('byFramework');
    expect(result).toHaveProperty('routes');
  });

  it('returns expected total/byMethod/byFramework structure from cached artifact', async () => {
    const payload = {
      total: 5,
      byMethod: { GET: 3, POST: 1, DELETE: 1 },
      byFramework: { nestjs: 4, fastapi: 1 },
      routes: [],
    };
    await writeAnalysisFile(tmpDir, ARTIFACT_ROUTE_INVENTORY, payload);

    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    expect(result.total).toBe(5);
    expect((result.byMethod as Record<string, number>)['GET']).toBe(3);
    expect((result.byMethod as Record<string, number>)['DELETE']).toBe(1);
    expect((result.byFramework as Record<string, number>)['nestjs']).toBe(4);
  });

  it('handles malformed JSON artifact gracefully — falls through to live extraction', async () => {
    // Write a corrupted artifact file
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_ROUTE_INVENTORY), 'not-valid-json!!!', 'utf-8');

    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    // Malformed JSON → JSON.parse throws → falls through to live extraction → cached: false
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('total');
  });
});

// ============================================================================
// handleGetMiddlewareInventory
// ============================================================================

describe('handleGetMiddlewareInventory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when middleware-inventory.json exists', async () => {
    const payload = [{ name: 'authMiddleware', file: 'src/middleware/auth.ts' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_MIDDLEWARE_INVENTORY, payload);
    const { handleGetMiddlewareInventory } = await import('./analysis.js');
    const result = await handleGetMiddlewareInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('falls back to live extraction (cached: false) when artifact absent', async () => {
    const { handleGetMiddlewareInventory } = await import('./analysis.js');
    const result = await handleGetMiddlewareInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('entries');
  });
});

// ============================================================================
// handleGetSchemaInventory
// ============================================================================

describe('handleGetSchemaInventory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when schema-inventory.json exists', async () => {
    const payload = [{ name: 'User', type: 'interface', file: 'src/types.ts' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_SCHEMA_INVENTORY, payload);
    const { handleGetSchemaInventory } = await import('./analysis.js');
    const result = await handleGetSchemaInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.schemas)).toBe(true);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetSchemaInventory } = await import('./analysis.js');
    const result = await handleGetSchemaInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('schemas');
  });
});

// ============================================================================
// handleGetUIComponents
// ============================================================================

describe('handleGetUIComponents', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when ui-inventory.json exists', async () => {
    const payload = [{ name: 'Button', file: 'src/components/Button.tsx' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_UI_INVENTORY, payload);
    const { handleGetUIComponents } = await import('./analysis.js');
    const result = await handleGetUIComponents(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.components)).toBe(true);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetUIComponents } = await import('./analysis.js');
    const result = await handleGetUIComponents(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('components');
  });
});

// ============================================================================
// handleGetEnvVars
// ============================================================================

describe('handleGetEnvVars', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when env-inventory.json exists', async () => {
    const payload = [{ name: 'DATABASE_URL', file: 'src/config.ts' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_ENV_INVENTORY, payload);
    const { handleGetEnvVars } = await import('./analysis.js');
    const result = await handleGetEnvVars(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.envVars)).toBe(true);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetEnvVars } = await import('./analysis.js');
    const result = await handleGetEnvVars(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('envVars');
  });

  // ConciseByDefaultDetailedOnRequest: a large inventory summarizes by default.
  it('defaults to a concise summary (sample + truncation receipt) for a large inventory', async () => {
    const payload = Array.from({ length: 30 }, (_, i) => ({ name: `VAR_${i}`, file: 'src/config.ts' }));
    await writeAnalysisFile(tmpDir, ARTIFACT_ENV_INVENTORY, payload);
    const { handleGetEnvVars } = await import('./analysis.js');
    const result = await handleGetEnvVars(tmpDir) as Record<string, unknown>;
    expect(result.responseFormat).toBe('concise');
    expect(result.total).toBe(30);
    expect((result.envVars as unknown[]).length).toBe(20); // CONCISE_INVENTORY_SAMPLE
    expect((result.truncation as { omitted: number }).omitted).toBe(10);
  });

  it('returns the full inventory with responseFormat:"detailed"', async () => {
    const payload = Array.from({ length: 30 }, (_, i) => ({ name: `VAR_${i}`, file: 'src/config.ts' }));
    await writeAnalysisFile(tmpDir, ARTIFACT_ENV_INVENTORY, payload);
    const { handleGetEnvVars } = await import('./analysis.js');
    const result = await handleGetEnvVars(tmpDir, 'detailed') as Record<string, unknown>;
    expect((result.envVars as unknown[]).length).toBe(30);
    expect(result.truncation).toBeUndefined();
  });
});

// ============================================================================
// handleGetExternalPackages
// ============================================================================

describe('handleGetExternalPackages', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when external-packages.json exists', async () => {
    const payload = { total: 2, packages: [{ name: 'express', version: '^4.18.0' }] };
    await writeAnalysisFile(tmpDir, ARTIFACT_EXTERNAL_PACKAGES, payload);
    const { handleGetExternalPackages } = await import('./analysis.js');
    const result = await handleGetExternalPackages(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(2);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetExternalPackages } = await import('./analysis.js');
    const result = await handleGetExternalPackages(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
  });
});

// ============================================================================
// handleGetMinimalContext
// ============================================================================

function makeCallGraph(overrides: Partial<{
  nodes: unknown[]; edges: unknown[];
}> = {}) {
  return {
    nodes: [],
    edges: [],
    entryPoints: [],
    hubFunctions: [],
    layerViolations: [],
    inheritanceEdges: [],
    classes: [],
    stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    ...overrides,
  };
}

describe('handleGetMinimalContext', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no call graph available', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'myFn') as { error: string };
    expect(result.error).toMatch(/No call graph/);
  });

  it('returns error when function not found in call graph', async () => {
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'nonExistentFn') as { error: string };
    expect(result.error).toMatch(/"nonExistentFn" not found/);
  });

  it('returns function metadata with callers and callees', async () => {
    const node = {
      id: 'src/a.ts::doWork', name: 'doWork', filePath: `${tmpDir}/src/a.ts`,
      signature: 'doWork(x: number): void', language: 'typescript',
      fanIn: 2, fanOut: 1, startLine: 1, endLine: 5,
      isExternal: false, isTest: false,
    };
    const callerNode = {
      id: 'src/b.ts::caller', name: 'caller', filePath: `${tmpDir}/src/b.ts`,
      signature: 'caller()', language: 'typescript',
      fanIn: 0, fanOut: 1, startLine: 1, endLine: 3,
      isExternal: false, isTest: false,
    };
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [node, callerNode],
        edges: [
          { callerId: 'src/b.ts::caller', calleeId: 'src/a.ts::doWork', calleeName: 'doWork', confidence: 'exact', kind: 'calls' },
        ],
      }),
    });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'doWork') as Record<string, unknown>;
    expect((result.function as Record<string, unknown>).name).toBe('doWork');
    expect(Array.isArray(result.callers)).toBe(true);
    expect((result.callers as unknown[]).length).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.callees)).toBe(true);
    expect(Array.isArray(result.testedBy)).toBe(true);
  });

  it('reads a valid in-root function body', async () => {
    const source = 'export function safeFn() { return 42; }\n';
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await writeFile(join(tmpDir, 'src', 'safe.ts'), source, 'utf-8');
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [{
          id: 'src/safe.ts::safeFn', name: 'safeFn', filePath: join(tmpDir, 'src', 'safe.ts'),
          signature: 'safeFn()', language: 'typescript', fanIn: 0, fanOut: 0,
          startIndex: 0, endIndex: source.length, isExternal: false, isTest: false,
        }],
      }),
    });

    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'safeFn') as { function: { file: string; body: string } };

    expect(result.function.file).toBe('src/safe.ts');
    expect(result.function.body).toBe(source);
  });

  it('does not read an absolute node path outside the project root', async () => {
    const outside = await createTmpDir();
    const secret = 'outside-absolute-secret';
    const secretPath = join(outside, 'secret.ts');
    await writeFile(secretPath, secret, 'utf-8');
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [{
          id: 'poison::leakAbsolute', name: 'leakAbsolute', filePath: secretPath,
          signature: 'leakAbsolute()', language: 'typescript', fanIn: 0, fanOut: 0,
          startIndex: 0, endIndex: secret.length, isExternal: false, isTest: false,
        }],
      }),
    });

    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'leakAbsolute') as { error: string };

    expect(result.error).toMatch(/not found/);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not read a node path through an in-root symlink that escapes the root', async () => {
    const outside = await createTmpDir();
    const secret = 'outside-symlink-secret';
    const secretPath = join(outside, 'secret.ts');
    await writeFile(secretPath, secret, 'utf-8');
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    const linkedPath = join(tmpDir, 'src', 'linked.ts');
    await symlink(secretPath, linkedPath);
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [{
          id: 'src/linked.ts::leakSymlink', name: 'leakSymlink', filePath: linkedPath,
          signature: 'leakSymlink()', language: 'typescript', fanIn: 0, fanOut: 0,
          startIndex: 0, endIndex: secret.length, isExternal: false, isTest: false,
        }],
      }),
    });

    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'leakSymlink') as { error: string };

    expect(result.error).toMatch(/not found/);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('includes testedBy edges when present', async () => {
    const node = {
      id: 'src/a.ts::compute', name: 'compute', filePath: `${tmpDir}/src/a.ts`,
      signature: 'compute()', language: 'typescript',
      fanIn: 0, fanOut: 0, startLine: 1, endLine: 3,
      isExternal: false, isTest: false,
    };
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [node],
        edges: [
          { callerId: 'src/a.ts::compute', calleeId: 'src/a.test.ts::testCompute', calleeName: 'compute.test.ts', confidence: 'import', kind: 'tested_by' },
        ],
      }),
    });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'compute') as { testedBy: Array<{ confidence: string }> };
    expect(result.testedBy).toHaveLength(1);
    expect(result.testedBy[0].confidence).toBe('imported');
  });

  it('ranks callers by nearest call-distance, surfaces a strong 2-hop chain, keeps weak direct, bounds far-weak', async () => {
    const mk = (id: string, fanIn = 0, fanOut = 0) => ({
      id, name: id.split('::')[1], filePath: `${tmpDir}/${id.split('::')[0]}`,
      signature: `${id.split('::')[1]}()`, language: 'typescript',
      fanIn, fanOut, startLine: 1, endLine: 3, isExternal: false, isTest: false,
    });
    // mid          →(import,1)→ target                 [direct strong:  distance 1]
    // strongCaller →(import,1)→ mid →(import,1)→ target[2-hop strong:   distance 2]
    // weakCaller   →(name_only,3)→ target              [direct weak:    distance 3, retained — floors at 3]
    // farWeak      →(name_only,3)→ strongCaller        [3-hop weak:     distance 5 > low budget 3 → excluded]
    const target = mk('src/t.ts::target', /* fanIn */ 2);
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [target, mk('src/w.ts::weakCaller'), mk('src/m.ts::mid'), mk('src/s.ts::strongCaller'), mk('src/f.ts::farWeak')],
        edges: [
          { callerId: 'src/m.ts::mid', calleeId: 'src/t.ts::target', calleeName: 'target', confidence: 'import', kind: 'calls' },
          { callerId: 'src/s.ts::strongCaller', calleeId: 'src/m.ts::mid', calleeName: 'mid', confidence: 'import', kind: 'calls' },
          { callerId: 'src/w.ts::weakCaller', calleeId: 'src/t.ts::target', calleeName: 'target', confidence: 'name_only', kind: 'calls' },
          { callerId: 'src/f.ts::farWeak', calleeId: 'src/s.ts::strongCaller', calleeName: 'strongCaller', confidence: 'name_only', kind: 'calls' },
        ],
      }),
    });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'target') as {
      callers: Array<{ name: string; distance: number; hops: number }>;
    };
    const names = result.callers.map(c => c.name);
    // nearest-first ordering: direct strong, then 2-hop strong, then weak direct
    expect(names).toEqual(['mid', 'strongCaller', 'weakCaller']);
    expect(names).not.toContain('farWeak'); // budget still bounds far weakly-resolved chains
    // no regression: the weakly-resolved direct caller is retained, not dropped
    expect(names).toContain('weakCaller');
    // each neighbour carries its provenance
    for (const c of result.callers) {
      expect(typeof c.distance).toBe('number');
      expect(typeof c.hops).toBe('number');
    }
    expect(result.callers.find(c => c.name === 'strongCaller')!.hops).toBe(2);
    expect(result.callers.find(c => c.name === 'weakCaller')!.distance).toBe(3);
  });

  it('does not return empty callers for a low-risk function whose only direct caller is weakly resolved', async () => {
    const mk = (id: string) => ({
      id, name: id.split('::')[1], filePath: `${tmpDir}/${id.split('::')[0]}`,
      signature: `${id.split('::')[1]}()`, language: 'typescript',
      fanIn: 1, fanOut: 0, startLine: 1, endLine: 3, isExternal: false, isTest: false,
    });
    const target = mk('src/t.ts::soloTarget');
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [target, mk('src/c.ts::onlyCaller')],
        edges: [
          { callerId: 'src/c.ts::onlyCaller', calleeId: 'src/t.ts::soloTarget', calleeName: 'soloTarget', confidence: 'name_only', kind: 'calls' },
        ],
      }),
    });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'soloTarget') as { callers: Array<{ name: string }> };
    expect(result.callers.map(c => c.name)).toEqual(['onlyCaller']);
  });

  it('flags a recursive function instead of listing it as its own caller/callee', async () => {
    const fn = {
      id: 'src/r.ts::walk', name: 'walk', filePath: `${tmpDir}/src/r.ts`,
      signature: 'walk()', language: 'typescript',
      fanIn: 1, fanOut: 1, startLine: 1, endLine: 5, isExternal: false, isTest: false,
    };
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [fn],
        edges: [
          { callerId: 'src/r.ts::walk', calleeId: 'src/r.ts::walk', calleeName: 'walk', confidence: 'same_file', kind: 'calls' },
        ],
      }),
    });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'walk') as {
      function: { recursive: boolean }; callers: Array<{ name: string }>; callees: Array<{ name: string }>;
    };
    expect(result.function.recursive).toBe(true);
    expect(result.callers.map(c => c.name)).not.toContain('walk'); // not its own neighbour
    expect(result.callees.map(c => c.name)).not.toContain('walk');
  });
});

// ============================================================================
// handleGetMinimalContext — opt-in personalized-PageRank ranking mode
// (change: add-personalized-pagerank-context-ranking)
// ============================================================================

describe('handleGetMinimalContext — pagerank ranking mode', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  const mk = (id: string, fanIn = 0, fanOut = 0) => ({
    id, name: id.split('::')[1], filePath: `${tmpDir}/${id.split('::')[0]}`,
    signature: `${id.split('::')[1]}()`, language: 'typescript',
    fanIn, fanOut, startLine: 1, endLine: 3, isExternal: false, isTest: false,
  });

  // A graph where, among the callers of `target`, `multi` is reachable by several
  // independent backward paths while `single` is reachable by one — at equal distance.
  function connectivityGraph() {
    return makeCallGraph({
      nodes: [
        mk('src/t.ts::target', 4),
        mk('src/a.ts::multi'), mk('src/b.ts::single'),
        mk('src/p.ts::p1'), mk('src/p.ts::p2'), mk('src/p.ts::p3'), mk('src/q.ts::q1'),
      ],
      edges: [
        // three independent 2-hop backward paths converge on `multi`
        { callerId: 'src/p.ts::p1', calleeId: 'src/t.ts::target', calleeName: 'target', confidence: 'import', kind: 'calls' },
        { callerId: 'src/p.ts::p2', calleeId: 'src/t.ts::target', calleeName: 'target', confidence: 'import', kind: 'calls' },
        { callerId: 'src/p.ts::p3', calleeId: 'src/t.ts::target', calleeName: 'target', confidence: 'import', kind: 'calls' },
        { callerId: 'src/a.ts::multi', calleeId: 'src/p.ts::p1', calleeName: 'p1', confidence: 'import', kind: 'calls' },
        { callerId: 'src/a.ts::multi', calleeId: 'src/p.ts::p2', calleeName: 'p2', confidence: 'import', kind: 'calls' },
        { callerId: 'src/a.ts::multi', calleeId: 'src/p.ts::p3', calleeName: 'p3', confidence: 'import', kind: 'calls' },
        // a single 2-hop backward path to `single`
        { callerId: 'src/q.ts::q1', calleeId: 'src/t.ts::target', calleeName: 'target', confidence: 'import', kind: 'calls' },
        { callerId: 'src/b.ts::single', calleeId: 'src/q.ts::q1', calleeName: 'q1', confidence: 'import', kind: 'calls' },
      ],
    });
  }

  it('default output is byte-identical with rankBy omitted vs rankBy="distance"', async () => {
    readCachedContext.mockResolvedValue({ callGraph: connectivityGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const omitted = await handleGetMinimalContext(tmpDir, 'target');
    const explicit = await handleGetMinimalContext(tmpDir, 'target', undefined, 'distance');
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
  });

  it('default output carries no pagerank fields (relevance / rankedBy)', async () => {
    readCachedContext.mockResolvedValue({ callGraph: connectivityGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'target') as Record<string, unknown>;
    expect(result.rankedBy).toBeUndefined();
    for (const c of result.callers as Array<Record<string, unknown>>) {
      expect(c.relevance).toBeUndefined();
    }
  });

  it('pagerank mode orders callers by connectivity, not just distance, and attaches relevance', async () => {
    readCachedContext.mockResolvedValue({ callGraph: connectivityGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'target', undefined, 'pagerank') as {
      rankedBy: string; callers: Array<{ name: string; relevance: number }>;
    };
    expect(result.rankedBy).toBe('pagerank');
    const multi = result.callers.find(c => c.name === 'multi')!;
    const single = result.callers.find(c => c.name === 'single')!;
    expect(multi).toBeTruthy();
    expect(single).toBeTruthy();
    // the many-paths caller outranks the single-path caller at equal distance
    expect(multi.relevance).toBeGreaterThan(single.relevance);
    expect(result.callers.findIndex(c => c.name === 'multi'))
      .toBeLessThan(result.callers.findIndex(c => c.name === 'single'));
  });

  it('pagerank mode is deterministic across runs', async () => {
    readCachedContext.mockResolvedValue({ callGraph: connectivityGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const a = await handleGetMinimalContext(tmpDir, 'target', undefined, 'pagerank');
    const b = await handleGetMinimalContext(tmpDir, 'target', undefined, 'pagerank');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('pagerank + tokenBudget fits the budget and reports omitted neighbours', async () => {
    readCachedContext.mockResolvedValue({ callGraph: connectivityGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    // A tiny budget forces overflow among the callers.
    const result = await handleGetMinimalContext(tmpDir, 'target', undefined, 'pagerank', 30) as {
      callers: unknown[];
      omittedForBudget?: { callers: number; callees: number; note: string };
    };
    expect(result.omittedForBudget).toBeTruthy();
    expect(result.omittedForBudget!.callers).toBeGreaterThan(0);
    expect(result.omittedForBudget!.note).toMatch(/tokenBudget/);
    // budget is binding: fewer callers than the full set fit
    expect(result.callers.length).toBeGreaterThanOrEqual(1);
  });

  it('tokenBudget is ignored in default (distance) mode — no silent truncation of the default shape', async () => {
    readCachedContext.mockResolvedValue({ callGraph: connectivityGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const budgeted = await handleGetMinimalContext(tmpDir, 'target', undefined, 'distance', 5);
    const plain = await handleGetMinimalContext(tmpDir, 'target');
    expect(JSON.stringify(budgeted)).toBe(JSON.stringify(plain));
  });
});

// ============================================================================
// handleGetCluster
// ============================================================================

describe('handleGetCluster', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no call graph', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'foo') as { error: string };
    expect(result.error).toMatch(/No call graph/);
  });

  it('returns error when function not found', async () => {
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph() });
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'missing') as { error: string };
    expect(result.error).toMatch(/"missing" not found/);
  });

  it('returns error when function has no community data', async () => {
    const node = {
      id: 'src/a.ts::fn', name: 'fn', filePath: `${tmpDir}/src/a.ts`,
      fanIn: 0, fanOut: 0, isExternal: false, isTest: false,
      // no communityId
    };
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph({ nodes: [node] }) });
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'fn') as { error: string };
    expect(result.error).toMatch(/No community data/);
  });

  it('returns cluster members and stats for function with communityId', async () => {
    const mkNode = (name: string) => ({
      id: `src/a.ts::${name}`, name, filePath: `${tmpDir}/src/a.ts`,
      fanIn: 1, fanOut: 1, isExternal: false, isTest: false,
      communityId: 42, communityLabel: 'auth-cluster',
    });
    const nodes = [mkNode('login'), mkNode('logout'), mkNode('refresh')];
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph({ nodes, edges: [] }) });
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'login') as Record<string, unknown>;
    expect(result.communityId).toBe(42);
    expect(result.communityLabel).toBe('auth-cluster');
    expect((result.stats as Record<string, number>).members).toBe(3);
    expect(Array.isArray(result.functions)).toBe(true);
  });
});

// ============================================================================
// handleDetectChanges
// ============================================================================

describe('handleDetectChanges', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no call graph', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleDetectChanges } = await import('./analysis.js');
    const result = await handleDetectChanges(tmpDir) as { error: string };
    expect(result.error).toMatch(/No call graph/);
  });

  it('returns git error when directory is not a git repository', async () => {
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph() });
    const { handleDetectChanges } = await import('./analysis.js');
    // tmpDir is not a git repo — git diff will fail
    const result = await handleDetectChanges(tmpDir) as { error: string };
    expect(result.error).toMatch(/git diff failed/);
  });

  // Regression: call-graph nodes store repo-root-RELATIVE filePaths. The diff
  // parser must key changed files by the same relative form, or no changed
  // function ever matches a node (handler returns "no matching function nodes").
  it('maps a real git diff to a node whose filePath is repo-relative', async () => {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: tmpDir, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'test@test.dev');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');

    const srcDir = join(tmpDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const file = join(srcDir, 'a.ts');
    await writeFile(file, 'export function doWork(x: number): number {\n  const y = x + 1;\n  return y;\n}\n', 'utf-8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    // Modify a line inside the function body in the working tree.
    await writeFile(file, 'export function doWork(x: number): number {\n  const y = x + 2;\n  return y;\n}\n', 'utf-8');

    // Node uses a RELATIVE filePath — the production convention.
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [{
          id: 'src/a.ts::doWork', name: 'doWork', filePath: 'src/a.ts',
          signature: 'doWork(x: number): number', language: 'typescript',
          fanIn: 3, fanOut: 0, startLine: 1, endLine: 4,
          isExternal: false, isTest: false,
        }],
      }),
    });

    const { handleDetectChanges } = await import('./analysis.js');
    const result = await handleDetectChanges(tmpDir) as {
      changedFunctions: Array<{ name: string; file: string }>;
      message?: string;
    };

    expect(result.message).toBeUndefined();
    expect(result.changedFunctions).toHaveLength(1);
    expect(result.changedFunctions[0].name).toBe('doWork');
    expect(result.changedFunctions[0].file).toBe('src/a.ts');
  });

  it('sets testCoverage=none and includes entry in testGaps when function has no test edges', async () => {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: tmpDir, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'test@test.dev');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    const srcDir = join(tmpDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const file = join(srcDir, 'b.ts');
    await writeFile(file, 'export function noTests(): void {\n  console.log(1);\n}\n', 'utf-8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    await writeFile(file, 'export function noTests(): void {\n  console.log(2);\n}\n', 'utf-8');

    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [{
          id: 'src/b.ts::noTests', name: 'noTests', filePath: 'src/b.ts',
          language: 'typescript', fanIn: 2, fanOut: 0, startLine: 1, endLine: 3,
          isExternal: false, isTest: false,
        }],
      }),
    });

    const { handleDetectChanges } = await import('./analysis.js');
    const result = await handleDetectChanges(tmpDir) as {
      changedFunctions: Array<{ name: string; testCoverage: string }>;
      testGaps: Array<{ name: string; file: string; riskScore: number; changeType: string }>;
    };

    expect(result.changedFunctions[0].testCoverage).toBe('none');
    expect(result.testGaps).toHaveLength(1);
    expect(result.testGaps[0].name).toBe('noTests');
    expect(result.testGaps[0].file).toBe('src/b.ts');
    expect(typeof result.testGaps[0].riskScore).toBe('number');
  });

  it('sets testCoverage=import-only when only import test edges exist and excludes from testGaps', async () => {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: tmpDir, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'test@test.dev');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    const srcDir = join(tmpDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const file = join(srcDir, 'c.ts');
    await writeFile(file, 'export function wellTested(): void {\n  console.log(1);\n}\n', 'utf-8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    await writeFile(file, 'export function wellTested(): void {\n  console.log(2);\n}\n', 'utf-8');

    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [{
          id: 'src/c.ts::wellTested', name: 'wellTested', filePath: 'src/c.ts',
          language: 'typescript', fanIn: 1, fanOut: 0, startLine: 1, endLine: 3,
          isExternal: false, isTest: false,
        }],
        edges: [{
          callerId: 'src/c.ts::wellTested',
          calleeId: 'src/c.test.ts::wellTested.test',
          calleeName: 'wellTested.test',
          confidence: 'import',
          kind: 'tested_by',
        }],
      }),
    });

    const { handleDetectChanges } = await import('./analysis.js');
    const result = await handleDetectChanges(tmpDir) as {
      changedFunctions: Array<{ name: string; testCoverage: string }>;
      testGaps: Array<unknown>;
    };

    expect(result.changedFunctions[0].testCoverage).toBe('import-only');
    expect(result.testGaps).toHaveLength(0);
  });

  it('sets testCoverage=direct when a called (non-import) test edge exists', async () => {
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: tmpDir, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'test@test.dev');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    const srcDir = join(tmpDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const file = join(srcDir, 'd.ts');
    await writeFile(file, 'export function directlyCovered(): void {\n  return;\n}\n', 'utf-8');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    await writeFile(file, 'export function directlyCovered(): void {\n  return undefined;\n}\n', 'utf-8');

    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [{
          id: 'src/d.ts::directlyCovered', name: 'directlyCovered', filePath: 'src/d.ts',
          language: 'typescript', fanIn: 1, fanOut: 0, startLine: 1, endLine: 3,
          isExternal: false, isTest: false,
        }],
        edges: [{
          callerId: 'src/d.ts::directlyCovered',
          calleeId: 'src/d.test.ts::it',
          calleeName: 'it',
          confidence: 'same_file', // non-'import' → maps to 'called' → testCoverage='direct'
          kind: 'tested_by',
        }],
      }),
    });

    const { handleDetectChanges } = await import('./analysis.js');
    const result = await handleDetectChanges(tmpDir) as {
      changedFunctions: Array<{ name: string; testCoverage: string }>;
      testGaps: Array<unknown>;
    };

    expect(result.changedFunctions[0].testCoverage).toBe('direct');
    expect(result.testGaps).toHaveLength(0);
  });
});

// ============================================================================
// handleAuditSpecCoverage
// ============================================================================

describe('handleAuditSpecCoverage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns an unavailable coverage disclosure when no analysis exists', async () => {
    const { handleAuditSpecCoverage } = await import('./analysis.js');
    const result = await handleAuditSpecCoverage(tmpDir) as { mappingCoverage: { state: string; remediation?: string } };
    expect(result.mappingCoverage.state).toBe('unavailable');
    expect(result.mappingCoverage.remediation).toMatch(/analy/i);
  });

  it('reports unavailable coverage with machine-readable remediation when no analysis can resolve anchors', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_LLM_CONTEXT, {
      callGraph: { nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [], inheritanceEdges: [], classes: [], stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } },
    });
    const { handleAuditSpecCoverage } = await import('./analysis.js');
    const result = await handleAuditSpecCoverage(tmpDir) as {
      mappingCoverage: { state: string; reason: string; remediation: string; artifactPath: string };
      summary: Record<string, unknown>;
    };
    expect(result.mappingCoverage).toMatchObject({
      state: 'unavailable', reason: 'analysis-unavailable',
      remediation: expect.stringContaining('openlore analyze'),
    });
    expect(result.mappingCoverage.artifactPath).toBe('.openlore/analysis/mapping.json');
    expect(result.mappingCoverage.artifactPath).not.toContain(tmpDir);
    expect(result.summary.coveragePct).toBeNull();
  });
});
