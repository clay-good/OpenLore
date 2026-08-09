/**
 * MappingGenerator Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MappingGenerator } from './mapping-generator.js';
import { mappingSourceFingerprint } from './mapping-generator.js';
import type { SemanticSearchFn } from './mapping-generator.js';
import type { SearchResult } from '../analyzer/vector-index.js';
import type { PipelineResult } from './spec-pipeline.js';
import type { DependencyGraphResult, DependencyNode } from '../analyzer/dependency-graph.js';
import type { ScoredFile } from '../../types/index.js';
import type { ExportInfo } from '../analyzer/import-parser.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `mapping-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeFile(path: string): ScoredFile {
  return {
    path,
    absolutePath: `/project/${path}`,
    name: path.split('/').pop()!,
    extension: '.ts',
    size: 100,
    lines: 10,
    depth: 2,
    directory: path.split('/').slice(0, -1).join('/'),
    isEntryPoint: false,
    isConfig: false,
    isTest: false,
    isGenerated: false,
    score: 1,
    scoreBreakdown: { name: 1, path: 1, structure: 1, connectivity: 1 },
    tags: [],
  };
}

function makeExport(name: string, kind: ExportInfo['kind'] = 'function', isType = false): ExportInfo {
  return { name, isDefault: false, isType, isReExport: false, kind, line: 1 };
}

function makeNode(filePath: string, exports: ExportInfo[]): DependencyNode {
  return {
    id: filePath,
    file: makeFile(filePath),
    exports,
    metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0 },
  };
}

function makeDepGraph(...nodes: DependencyNode[]): DependencyGraphResult {
  return {
    nodes,
    edges: [],
    clusters: [],
    structuralClusters: [],
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    cycles: [],
    statistics: { nodeCount: nodes.length, edgeCount: 0, importEdgeCount: 0, httpEdgeCount: 0, avgDegree: 0, density: 0, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0 },
  };
}

function makePipeline(services: PipelineResult['services']): PipelineResult {
  return {
    survey: {
      projectCategory: 'library',
      primaryLanguage: 'TypeScript',
      frameworks: [],
      architecturePattern: 'layered',
      domainSummary: 'test',
      suggestedDomains: [],
      confidence: 1,
      schemaFiles: [],
      serviceFiles: [],
      apiFiles: [],
    },
    entities: [],
    services,
    endpoints: [],
    architecture: {
      systemPurpose: 'test',
      architectureStyle: 'layered',
      layerMap: [],
      dataFlow: 'linear',
      integrations: [],
      securityModel: 'none',
      keyDecisions: [],
    },
    metadata: { totalTokens: 0, estimatedCost: 0, duration: 0, completedStages: [], skippedStages: [] },
  };
}

// ============================================================================
// similarityScore (tested via generate() outcomes)
// ============================================================================

describe('MappingGenerator — similarity matching', () => {
  let tmpDir: string;
  let generator: MappingGenerator;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await mkdir(join(tmpDir, '.openlore', 'analysis'), { recursive: true });
    generator = new MappingGenerator(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('matches via exact normalized name (score 1.0)', async () => {
    // op.name "getUserById" vs export "getUserById" → exact match
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'handles auth',
      operations: [{ name: 'getUserById', description: 'get user', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('getUserById')]));

    const artifact = await generator.generate(pipeline, graph);
    const mapping = artifact.mappings[0];
    expect(mapping.functions).toHaveLength(1);
    expect(mapping.functions[0].name).toBe('getUserById');
    expect(mapping.functions[0].confidence).toBe('heuristic'); // heuristic path (no functionName on op)
    expect(artifact).toMatchObject({ version: 2, sourceAnalysisFingerprint: mappingSourceFingerprint(graph) });
  });

  it('matches via containment (score 0.8) — operation name contained in function name', async () => {
    // "login" contained in "loginUser" → score 0.8 >= 0.7
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'handles auth',
      operations: [{ name: 'login', description: 'log in user', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('loginUser')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions[0].name).toBe('loginUser');
  });

  it('matches via token overlap (score ×0.7) — shared camelCase tokens', async () => {
    // "validateEmail" tokens: [validate, email] vs "emailValidator" tokens: [email, validator]
    // intersection = [email], union = [validate, email, validator] → 1/3 * 0.7 ≈ 0.23 < 0.7 → no match
    // But "fetchUserData" vs "getUserData" tokens overlap: [user, data] / [fetch, user, data, get, user, data]
    // Let's try "processPayment" vs "paymentProcessor"
    // normalize: "processpayment" vs "paymentprocessor" — containment check: neither contains the other
    // tokenize: [process, payment] vs [payment, processor]
    // intersection = [payment], union = [process, payment, processor] → 1/3 * 0.7 ≈ 0.23 < 0.7 → no match
    //
    // Use "handleUser" vs "userHandler": tokens [handle, user] vs [user, handler]
    // intersection = [user], union = [handle, user, handler] = 3 → 1/3 * 0.7 ≈ 0.23 < 0.7 → no match
    //
    // For token overlap to be >= 0.7: need intersection/union * 0.7 >= 0.7 → intersection/union >= 1 → all same tokens
    // "createUser" tokens [create, user] vs "createUser" → exact match (score 1.0)
    // "create user" tokens [create, user] vs "userCreate" tokens [user, create] → same tokens, score = 2/2 * 0.7 = 0.7
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'handles auth',
      operations: [{ name: 'create user', description: 'create', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('userCreate')]));

    const artifact = await generator.generate(pipeline, graph);
    // Tokens: [create, user] vs [user, create] → intersection=2, union=2 → 2/2 * 0.7 = 0.7 → match
    expect(artifact.mappings[0].functions[0].name).toBe('userCreate');
  });

  it('does not match when similarity is below 0.7', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'handles auth',
      operations: [{ name: 'deleteAccount', description: 'delete account', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    // "listFiles": normalize = "listfiles", tokens = [list, files]
    // "deleteAccount": normalize = "deleteaccount", tokens = [delete, account]
    // No containment, no token overlap → score = 0 < 0.7
    const graph = makeDepGraph(makeNode('src/files.ts', [makeExport('listFiles')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions).toHaveLength(0);
  });

  it('skips type-only exports', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'handles auth',
      operations: [{ name: 'UserType', description: 'type', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    // Export with same name but isType = true should be excluded from export index
    const graph = makeDepGraph(makeNode('src/types.ts', [
      makeExport('UserType', 'type', true),  // type-only, should be skipped
    ]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions).toHaveLength(0);
    expect(artifact.stats.totalExportedFunctions).toBe(0);
  });
});

// ============================================================================
// LLM confidence path
// ============================================================================

describe('MappingGenerator — LLM-provided functionName', () => {
  let tmpDir: string;
  let generator: MappingGenerator;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await mkdir(join(tmpDir, '.openlore', 'analysis'), { recursive: true });
    generator = new MappingGenerator(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses LLM functionName when present and found in export index', async () => {
    const pipeline = makePipeline([{
      name: 'PaymentsService',
      purpose: 'handles payments',
      operations: [{
        name: 'ProcessRefund',
        description: 'process a refund',
        scenarios: [],
        functionName: 'processRefund',  // LLM-provided
      }],
      dependencies: [],
      sideEffects: [],
      domain: 'payments',
    }]);
    const graph = makeDepGraph(makeNode('src/payments.ts', [makeExport('processRefund')]));

    const artifact = await generator.generate(pipeline, graph);
    const fn = artifact.mappings[0].functions[0];
    expect(fn.name).toBe('processRefund');
    expect(fn.confidence).toBe('llm');
  });

  it('falls back to heuristic when LLM functionName not in export index', async () => {
    const pipeline = makePipeline([{
      name: 'PaymentsService',
      purpose: 'handles payments',
      operations: [{
        name: 'ProcessRefund',
        description: 'process refund',
        scenarios: [],
        functionName: 'nonExistentFunction',  // not in graph
      }],
      dependencies: [],
      sideEffects: [],
      domain: 'payments',
    }]);
    const graph = makeDepGraph(makeNode('src/payments.ts', [makeExport('processRefund')]));

    const artifact = await generator.generate(pipeline, graph);
    // LLM name not found → heuristic fallback → finds processRefund by similarity
    const fn = artifact.mappings[0].functions[0];
    expect(fn.name).toBe('processRefund');
    expect(fn.confidence).toBe('heuristic');
  });

  it('uses LLM functionName with whitespace trimmed', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{
        name: 'Login',
        description: 'login',
        scenarios: [],
        functionName: '  loginUser  ',  // extra whitespace
      }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('loginUser')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions[0].confidence).toBe('llm');
    expect(artifact.mappings[0].functions[0].name).toBe('loginUser');
  });
});

// ============================================================================
// Orphan detection
// ============================================================================

describe('MappingGenerator — orphan detection', () => {
  let tmpDir: string;
  let generator: MappingGenerator;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await mkdir(join(tmpDir, '.openlore', 'analysis'), { recursive: true });
    generator = new MappingGenerator(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('identifies exported functions not matched to any requirement', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'login', description: 'login', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    // loginUser matches "login" (containment), but helperUtil does not match anything
    const graph = makeDepGraph(makeNode('src/auth.ts', [
      makeExport('loginUser'),
      makeExport('helperUtil'),  // orphan — no requirement references this
    ]));

    const artifact = await generator.generate(pipeline, graph);
    const orphanNames = artifact.orphanFunctions.map(f => f.name);
    expect(orphanNames).toContain('helperUtil');
    expect(orphanNames).not.toContain('loginUser');
  });

  it('does not list matched functions as orphans', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'login', description: 'login', scenarios: [], functionName: 'loginUser' }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('loginUser')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.orphanFunctions).toHaveLength(0);
  });

  it('includes correct file and name for orphan functions', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'completelyDifferent', description: 'x', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/utils.ts', [makeExport('formatDate')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.orphanFunctions[0].name).toBe('formatDate');
    expect(artifact.orphanFunctions[0].file).toBe('src/utils.ts');
    expect(artifact.orphanFunctions[0].confidence).toBe('heuristic');
  });
});

// ============================================================================
// Stats accuracy
// ============================================================================

describe('MappingGenerator — stats', () => {
  let tmpDir: string;
  let generator: MappingGenerator;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await mkdir(join(tmpDir, '.openlore', 'analysis'), { recursive: true });
    generator = new MappingGenerator(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('counts totalRequirements as number of operations across all services', async () => {
    const pipeline = makePipeline([
      {
        name: 'ServiceA',
        purpose: 'a',
        operations: [
          { name: 'opA1', description: '', scenarios: [] },
          { name: 'opA2', description: '', scenarios: [] },
        ],
        dependencies: [],
        sideEffects: [],
        domain: 'core',
      },
      {
        name: 'ServiceB',
        purpose: 'b',
        operations: [{ name: 'opB1', description: '', scenarios: [] }],
        dependencies: [],
        sideEffects: [],
        domain: 'core',
      },
    ]);
    const graph = makeDepGraph();

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.stats.totalRequirements).toBe(3);
  });

  it('counts mappedRequirements only for operations with at least one function', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [
        { name: 'loginUser', description: 'login', scenarios: [] },      // will match
        { name: 'deleteAccount', description: 'delete', scenarios: [] }, // won't match
      ],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('loginUser')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.stats.mappedRequirements).toBe(1);
    expect(artifact.stats.totalRequirements).toBe(2);
  });

  it('counts totalExportedFunctions correctly across multiple files', async () => {
    const pipeline = makePipeline([]);
    const graph = makeDepGraph(
      makeNode('src/a.ts', [makeExport('fnA1'), makeExport('fnA2')]),
      makeNode('src/b.ts', [makeExport('fnB1')]),
    );

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.stats.totalExportedFunctions).toBe(3);
  });

  it('excludes type-only exports from totalExportedFunctions', async () => {
    const pipeline = makePipeline([]);
    const graph = makeDepGraph(makeNode('src/types.ts', [
      makeExport('MyInterface', 'interface', true),  // isType = true
      makeExport('myFunction', 'function', false),
    ]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.stats.totalExportedFunctions).toBe(1);
  });

  it('orphanCount matches orphanFunctions length', async () => {
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'loginUser', description: 'login', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [
      makeExport('loginUser'),
      makeExport('unusedExport'),
      makeExport('anotherUnused'),
    ]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.stats.orphanCount).toBe(artifact.orphanFunctions.length);
    expect(artifact.stats.orphanCount).toBe(2);
  });
});

// ============================================================================
// Output structure
// ============================================================================

describe('MappingGenerator — output', () => {
  let tmpDir: string;
  let generator: MappingGenerator;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await mkdir(join(tmpDir, '.openlore', 'analysis'), { recursive: true });
    generator = new MappingGenerator(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes mapping.json to .openlore/analysis/', async () => {
    const pipeline = makePipeline([]);
    const graph = makeDepGraph();

    await generator.generate(pipeline, graph);

    const content = await readFile(join(tmpDir, '.openlore', 'analysis', 'mapping.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toHaveProperty('mappings');
    expect(parsed).toHaveProperty('orphanFunctions');
    expect(parsed).toHaveProperty('stats');
    expect(parsed).toHaveProperty('generatedAt');
  });

  it('sets correct specFile path for domain', async () => {
    const pipeline = makePipeline([{
      name: 'PaymentsService',
      purpose: 'payments',
      operations: [{ name: 'pay', description: 'pay', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'Payments',  // uppercase — should be lowercased
    }]);
    const graph = makeDepGraph();

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].specFile).toBe('openspec/specs/payments/spec.md');
  });

  it('uses "core" as domain fallback when service.domain is empty', async () => {
    const pipeline = makePipeline([{
      name: 'SomeService',
      purpose: 'something',
      operations: [{ name: 'doThing', description: 'do thing', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: '',  // empty → fallback to 'core'
    }]);
    const graph = makeDepGraph();

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].domain).toBe('core');
  });

  it('load() returns null when mapping.json does not exist', async () => {
    const result = await MappingGenerator.load(tmpDir);
    expect(result).toBeNull();
  });

  it('load() returns parsed artifact when mapping.json exists', async () => {
    const pipeline = makePipeline([]);
    const graph = makeDepGraph();

    const written = await generator.generate(pipeline, graph);
    const loaded = await MappingGenerator.load(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.generatedAt).toBe(written.generatedAt);
    expect(loaded!.stats).toEqual(written.stats);
  });

  it('respects custom openspecPath in specFile', async () => {
    generator = new MappingGenerator(tmpDir, 'custom/specs-dir');
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'login', description: 'login', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph();

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].specFile).toBe('custom/specs-dir/specs/auth/spec.md');
  });
});

// ============================================================================
// Semantic search tier
// ============================================================================

/** Build a minimal SearchResult for a function name with a given cosine distance */
function makeSearchResult(name: string, distance: number): SearchResult {
  return {
    record: {
      id: `id-${name}`,
      name,
      filePath: `src/${name}.ts`,
      className: '',
      language: 'TypeScript',
      signature: `function ${name}(): void`,
      docstring: '',
      fanIn: 0,
      fanOut: 0,
      isHub: false,
      isEntryPoint: false,
      text: name,
    },
    score: distance,
  };
}

describe('MappingGenerator — semantic search tier', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await mkdir(join(tmpDir, '.openlore', 'analysis'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses semantic match when LLM functionName is absent and heuristic would miss', async () => {
    // "authenticate user" semantically matches "validateCredentials" (distance 0.2 < 0.35)
    // but heuristic would score 0 (no token overlap)
    const mockSearch: SemanticSearchFn = async (_query, _limit) => [
      makeSearchResult('validateCredentials', 0.2),
    ];

    const generator = new MappingGenerator(tmpDir, 'openspec', mockSearch);
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'authenticate user', description: 'authenticate the user', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/validateCredentials.ts', [makeExport('validateCredentials')]));

    const artifact = await generator.generate(pipeline, graph);
    const fn = artifact.mappings[0].functions[0];
    expect(fn.name).toBe('validateCredentials');
    expect(fn.confidence).toBe('semantic');
  });

  it('skips semantic results with distance above threshold (0.35)', async () => {
    // distance 0.4 > 0.35 → rejected, falls through to heuristic which also misses → 0 functions
    const mockSearch: SemanticSearchFn = async (_query, _limit) => [
      makeSearchResult('validateCredentials', 0.4),
    ];

    const generator = new MappingGenerator(tmpDir, 'openspec', mockSearch);
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'authenticate user', description: 'authenticate', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/validateCredentials.ts', [makeExport('validateCredentials')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions).toHaveLength(0);
  });

  it('semantic tier is skipped when LLM functionName already matched', async () => {
    const mockSearch = vi.fn<SemanticSearchFn>();

    const generator = new MappingGenerator(tmpDir, 'openspec', mockSearch);
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{
        name: 'Login',
        description: 'login user',
        scenarios: [],
        functionName: 'loginUser',
      }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('loginUser')]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions[0].confidence).toBe('llm');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('semantic tier is skipped when heuristic would be unnecessary (semantic not provided)', async () => {
    // No semantic search function → falls straight to heuristic
    const generator = new MappingGenerator(tmpDir, 'openspec');
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'loginUser', description: 'login', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('loginUser')]));

    const artifact = await generator.generate(pipeline, graph);
    // heuristic matched (exact normalized), confidence = 'heuristic'
    expect(artifact.mappings[0].functions[0].confidence).toBe('heuristic');
  });

  it('passes operation name + description as query to semantic search', async () => {
    let capturedQuery = '';
    const mockSearch: SemanticSearchFn = async (query, _limit) => {
      capturedQuery = query;
      return [];
    };

    const generator = new MappingGenerator(tmpDir, 'openspec', mockSearch);
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'login', description: 'authenticate the user securely', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('unrelatedFn')]));

    await generator.generate(pipeline, graph);
    expect(capturedQuery).toBe('login authenticate the user securely');
  });

  it('falls back gracefully when semantic search throws', async () => {
    const mockSearch: SemanticSearchFn = async () => { throw new Error('index unavailable'); };

    const generator = new MappingGenerator(tmpDir, 'openspec', mockSearch);
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'loginUser', description: 'login', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [makeExport('loginUser')]));

    // Should not throw; heuristic picks up loginUser
    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions[0].name).toBe('loginUser');
    expect(artifact.mappings[0].functions[0].confidence).toBe('heuristic');
  });

  it('caps semantic results at 2 functions per operation', async () => {
    // 3 close results, all below threshold — only 2 should be returned
    const mockSearch: SemanticSearchFn = async (_query, _limit) => [
      makeSearchResult('fnA', 0.1),
      makeSearchResult('fnB', 0.15),
      makeSearchResult('fnC', 0.2),
    ];

    const generator = new MappingGenerator(tmpDir, 'openspec', mockSearch);
    const pipeline = makePipeline([{
      name: 'AuthService',
      purpose: 'auth',
      operations: [{ name: 'authenticate', description: 'auth', scenarios: [] }],
      dependencies: [],
      sideEffects: [],
      domain: 'auth',
    }]);
    const graph = makeDepGraph(makeNode('src/auth.ts', [
      makeExport('fnA'),
      makeExport('fnB'),
      makeExport('fnC'),
    ]));

    const artifact = await generator.generate(pipeline, graph);
    expect(artifact.mappings[0].functions).toHaveLength(2);
    expect(artifact.mappings[0].functions.every(f => f.confidence === 'semantic')).toBe(true);
  });
});
