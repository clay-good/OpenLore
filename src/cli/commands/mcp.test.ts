/**
 * Tests for the MCP server:
 *   - Security helpers: validateDirectory, sanitizeMcpError
 *   - Tool handlers: handleGetRefactorReport, handleGetCallGraph,
 *     handleGetSignatures, handleGetMapping, handleGetSubgraph,
 *     handleAnalyzeImpact, handleGetLowRiskRefactorCandidates,
 *     handleGetLeafFunctions, handleGetCriticalHubs, handleCheckSpecDrift
 *
 * Strategy: write fixture files (llm-context.json, mapping.json) to a
 * temporary directory, then call the real exported handlers directly.
 * This gives genuine line coverage of mcp.ts without spawning an MCP server.
 *
 * handleCheckSpecDrift uses vi.mock for the drift and config-manager modules
 * because those require a live git repository and LLM configuration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted — must appear before any imports that transitively
// load these modules.
vi.mock('../../core/drift/index.js', () => ({
  isGitRepository: vi.fn(),
  getChangedFiles: vi.fn(),
  buildSpecMap: vi.fn(),
  buildADRMap: vi.fn(),
  detectDrift: vi.fn(),
}));

vi.mock('../../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(),
}));

vi.mock('../../core/analyzer/vector-index.js', () => ({
  VectorIndex: {
    exists: vi.fn(),
    search: vi.fn(),
    build: vi.fn(),
  },
}));

vi.mock('../../core/analyzer/embedding-service.js', () => ({
  EmbeddingService: {
    fromEnv: vi.fn(),
    fromConfig: vi.fn(),
  },
}));
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore } from '../../core/services/edge-store.js';
import {
  validateDirectory,
  sanitizeMcpError,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetCallGraph,
  handleGetSignatures,
  handleGetMapping,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleCheckSpecDrift,
  handleSuggestInsertionPoints,
} from './mcp.js';
import { VectorIndex } from '../../core/analyzer/vector-index.js';
import { EmbeddingService } from '../../core/analyzer/embedding-service.js';
import type { SerializedCallGraph, FunctionNode } from '../../core/analyzer/call-graph.js';
import type { MappingArtifact } from '../../core/generator/mapping-generator.js';
import type { FileSignatureMap } from '../../core/analyzer/signature-extractor.js';
import type { DriftResult } from '../../types/index.js';
import {
  isGitRepository,
  getChangedFiles,
  buildSpecMap,
  buildADRMap,
  detectDrift,
} from '../../core/drift/index.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';

// ============================================================================
// Fixture helpers
// ============================================================================

function makeNode(overrides: {
  id: string; name: string; filePath: string;
  fanIn?: number; fanOut?: number; className?: string; language?: string;
}): FunctionNode {
  return {
    id: overrides.id, name: overrides.name, filePath: overrides.filePath,
    className: overrides.className, isAsync: false,
    language: overrides.language ?? 'TypeScript',
    startIndex: 0, endIndex: 100,
    fanIn: overrides.fanIn ?? 0, fanOut: overrides.fanOut ?? 0,
  };
}

/**
 * Graph fixture:
 *   entry ──► hub ──► workerA
 *              │      workerB
 *              └────► util
 *   leaf   (fanIn=0, no edges — dead code candidate)
 *   util   (fanIn=2, no outgoing — pure leaf)
 */
function makeCallGraph(): SerializedCallGraph {
  const entry   = makeNode({ id: 'f1', name: 'entry',   filePath: 'src/api/entry.ts',       fanIn: 0, fanOut: 1 });
  const hub     = makeNode({ id: 'f2', name: 'hub',     filePath: 'src/services/hub.ts',    fanIn: 1, fanOut: 3 });
  const workerA = makeNode({ id: 'f3', name: 'workerA', filePath: 'src/workers/workerA.ts', fanIn: 1, fanOut: 0 });
  const workerB = makeNode({ id: 'f4', name: 'workerB', filePath: 'src/workers/workerB.ts', fanIn: 1, fanOut: 0 });
  const leaf    = makeNode({ id: 'f5', name: 'leaf',    filePath: 'src/utils/leaf.ts',      fanIn: 0, fanOut: 0 });
  const util    = makeNode({ id: 'f6', name: 'util',    filePath: 'src/utils/util.ts',      fanIn: 2, fanOut: 0 });

  return {
    nodes: [entry, hub, workerA, workerB, leaf, util],
    edges: [
      { callerId: 'f1', calleeId: 'f2', calleeName: 'hub',     line: 10, confidence: 'name_only' as const },
      { callerId: 'f2', calleeId: 'f3', calleeName: 'workerA', line: 20, confidence: 'name_only' as const },
      { callerId: 'f2', calleeId: 'f4', calleeName: 'workerB', line: 21, confidence: 'name_only' as const },
      { callerId: 'f2', calleeId: 'f6', calleeName: 'util',    line: 22, confidence: 'name_only' as const },
      { callerId: 'f1', calleeId: 'f6', calleeName: 'util',    line: 11, confidence: 'name_only' as const },
    ],
    classes:         [],
    inheritanceEdges: [],
    hubFunctions:    [hub],
    entryPoints:     [entry],
    layerViolations: [],
    stats: { totalNodes: 6, totalEdges: 5, avgFanIn: 1, avgFanOut: 1 },
  };
}

async function writeCacheFixture(
  dir: string,
  callGraph: object,
  signatures: FileSignatureMap[] = []
) {
  const analysisDir = join(dir, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  await writeFile(
    join(analysisDir, 'llm-context.json'),
    JSON.stringify({ callGraph, signatures }),
    'utf-8'
  );
  // Write call-graph.db so handlers that require edgeStore work
  const cg = callGraph as SerializedCallGraph;
  if (cg.nodes) {
    const store = EdgeStore.open(EdgeStore.dbPath(analysisDir));
    const hubIds   = new Set((cg.hubFunctions   ?? []).map(n => n.id));
    const entryIds = new Set((cg.entryPoints     ?? []).map(n => n.id));
    store.insertNodes(cg.nodes, hubIds, entryIds);
    if (cg.edges) store.insertEdges(cg.edges);
    store.close();
  }
}

async function writeMappingFixture(dir: string, mapping: MappingArtifact) {
  const analysisDir = join(dir, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
  await writeFile(join(analysisDir, 'mapping.json'), JSON.stringify(mapping), 'utf-8');
}

function makeMapping(): MappingArtifact {
  return {
    generatedAt: '2026-01-01T00:00:00Z',
    mappings: [
      {
        requirement: 'Authenticate User',
        service: 'AuthService',
        domain: 'auth',
        specFile: 'openspec/specs/auth/spec.md',
        functions: [{ name: 'authenticate', file: 'src/auth/auth.ts', line: 10, kind: 'function', confidence: 'llm' }],
      },
      {
        requirement: 'Place Order',
        service: 'OrderService',
        domain: 'orders',
        specFile: 'openspec/specs/orders/spec.md',
        functions: [{ name: 'placeOrder', file: 'src/orders/service.ts', line: 50, kind: 'function', confidence: 'heuristic' }],
      },
    ],
    orphanFunctions: [
      { name: 'oldHelper', file: 'src/utils/legacy.ts', line: 5, kind: 'function', confidence: 'heuristic' },
    ],
    stats: { totalRequirements: 2, mappedRequirements: 2, totalExportedFunctions: 10, orphanCount: 1 },
  };
}

function makeSignatures(): FileSignatureMap[] {
  return [
    {
      path: 'src/api/routes.ts',
      language: 'TypeScript',
      entries: [
        { kind: 'function', name: 'handleRequest', signature: 'async function handleRequest(req: Request): Promise<Response>', docstring: 'Main request handler' },
      ],
    },
    {
      path: 'src/services/auth.ts',
      language: 'TypeScript',
      entries: [
        { kind: 'class', name: 'AuthService', signature: 'class AuthService', docstring: 'Authentication service' },
        { kind: 'method', name: 'authenticate', signature: 'authenticate(token: string): boolean', docstring: '' },
      ],
    },
  ];
}

// ============================================================================
// validateDirectory
// ============================================================================

describe('validateDirectory', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns the resolved absolute path for a valid directory', async () => {
    const result = await validateDirectory(testDir);
    expect(result).toBe(testDir);
  });

  it('resolves relative paths to absolute', async () => {
    const result = await validateDirectory('.');
    expect(result).toMatch(/^\//);
  });

  it('throws when the path does not exist', async () => {
    await expect(validateDirectory('/nonexistent/path/that/does/not/exist'))
      .rejects.toThrow('Directory not found');
  });

  it('throws when the path points to a file, not a directory', async () => {
    const filePath = join(testDir, 'afile.txt');
    await writeFile(filePath, 'content');
    await expect(validateDirectory(filePath)).rejects.toThrow('Not a directory');
  });

  it('throws for empty string input', async () => {
    await expect(validateDirectory('')).rejects.toThrow();
  });

  it('blocks path traversal that resolves to a file (e.g. /etc/hosts)', async () => {
    await expect(validateDirectory('/etc/hosts')).rejects.toThrow('Not a directory');
  });
});

// ============================================================================
// sanitizeMcpError
// ============================================================================

describe('sanitizeMcpError', () => {
  it('redacts Anthropic API keys (sk-ant-...)', () => {
    const err = new Error('Request failed: sk-ant-api03-ABCDEF1234567890abcdef1234');
    expect(sanitizeMcpError(err)).not.toContain('sk-ant-');
    expect(sanitizeMcpError(err)).toContain('[REDACTED]');
  });

  it('redacts OpenAI-style API keys (sk-...)', () => {
    const err = new Error('Unauthorized: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(sanitizeMcpError(err)).not.toMatch(/sk-proj-\S+/);
    expect(sanitizeMcpError(err)).toContain('[REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    const err = new Error('Auth error: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload');
    expect(sanitizeMcpError(err)).not.toContain('eyJhbGciO');
    expect(sanitizeMcpError(err)).toContain('Bearer [REDACTED]');
  });

  it('redacts Authorization header values', () => {
    const err = new Error('Header: Authorization: sk-secret-token-12345');
    expect(sanitizeMcpError(err)).not.toContain('sk-secret');
    expect(sanitizeMcpError(err)).toContain('Authorization: [REDACTED]');
  });

  it('redacts api_key= patterns', () => {
    const err = new Error('api_key=supersecret1234');
    expect(sanitizeMcpError(err)).not.toContain('supersecret');
    expect(sanitizeMcpError(err)).toContain('[REDACTED]');
  });

  it('preserves non-sensitive error messages unchanged', () => {
    const err = new Error('Directory not found: /tmp/project');
    expect(sanitizeMcpError(err)).toBe('Directory not found: /tmp/project');
  });

  it('handles non-Error thrown values', () => {
    expect(sanitizeMcpError('plain string error')).toBe('plain string error');
    expect(sanitizeMcpError(42)).toBe('42');
  });

  it('does not redact short tokens (avoids false positives on short words)', () => {
    const err = new Error('key: sk-short');
    expect(sanitizeMcpError(err)).toBe('key: sk-short');
  });
});

// ============================================================================
// handleGetRefactorReport
// ============================================================================

describe('handleGetRefactorReport', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-refactor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await handleGetRefactorReport(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns error when callGraph is missing from cache', async () => {
    const analysisDir = join(testDir, '.openlore', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify({ signatures: [] }));
    const r = await handleGetRefactorReport(testDir) as { error: string };
    expect(r.error).toMatch(/Call graph not available/);
  });

  it('returns a report with priorities and stats when call graph is present', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetRefactorReport(testDir) as { priorities: unknown[]; stats: Record<string, number> };
    expect(r).toHaveProperty('priorities');
    expect(r).toHaveProperty('stats');
    expect(Array.isArray(r.priorities)).toBe(true);
  });

  it('reports hub as high_fan_out when fanOut is elevated', async () => {
    const cg = makeCallGraph();
    cg.nodes[1].fanOut = 10;
    await writeCacheFixture(testDir, cg);
    const r = await handleGetRefactorReport(testDir) as { priorities: Array<{ function: string; issues: string[] }> };
    const hubEntry = r.priorities.find(p => p.function === 'hub');
    expect(hubEntry?.issues).toContain('high_fan_out');
  });
});

// ============================================================================
// handleGetCallGraph
// ============================================================================

describe('handleGetCallGraph', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-cg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await handleGetCallGraph(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns error when callGraph is missing from cache', async () => {
    const analysisDir = join(testDir, '.openlore', 'analysis');
    await mkdir(analysisDir, { recursive: true });
    await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify({ signatures: [] }));
    const r = await handleGetCallGraph(testDir) as { error: string };
    expect(r.error).toMatch(/Call graph not available/);
  });

  it('returns stats, hubFunctions, entryPoints, layerViolations', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetCallGraph(testDir) as {
      stats: object; hubFunctions: unknown[]; entryPoints: unknown[]; layerViolations: unknown[];
    };
    expect(r).toHaveProperty('stats');
    expect(r).toHaveProperty('hubFunctions');
    expect(r).toHaveProperty('entryPoints');
    expect(r).toHaveProperty('layerViolations');
  });

  it('hubFunctions contains hub with name and file', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetCallGraph(testDir) as { hubFunctions: Array<{ name: string; file: string }> };
    expect(r.hubFunctions).toHaveLength(1);
    expect(r.hubFunctions[0].name).toBe('hub');
    expect(r.hubFunctions[0].file).toBe('src/services/hub.ts');
  });

  it('entryPoints contains entry with name and file', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetCallGraph(testDir) as { entryPoints: Array<{ name: string; file: string }> };
    expect(r.entryPoints).toHaveLength(1);
    expect(r.entryPoints[0].name).toBe('entry');
  });

  it('layerViolations is empty when none exist', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetCallGraph(testDir) as { layerViolations: unknown[] };
    expect(r.layerViolations).toHaveLength(0);
  });
});

// ============================================================================
// handleGetSignatures
// ============================================================================

describe('handleGetSignatures', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-sigs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error string when no cache exists', async () => {
    const r = await handleGetSignatures(testDir);
    expect(r).toMatch(/analyze_codebase first/);
  });

  it('returns message when cache has no signatures', async () => {
    await writeCacheFixture(testDir, makeCallGraph(), []);
    const r = await handleGetSignatures(testDir);
    expect(r).toMatch(/No signatures available/);
  });

  it('returns formatted signatures when present', async () => {
    await writeCacheFixture(testDir, makeCallGraph(), makeSignatures());
    const r = await handleGetSignatures(testDir);
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
    expect(r).toContain('handleRequest');
    expect(r).toContain('AuthService');
  });

  it('filters by filePattern substring', async () => {
    await writeCacheFixture(testDir, makeCallGraph(), makeSignatures());
    const r = await handleGetSignatures(testDir, 'api');
    expect(r).toContain('handleRequest');
    expect(r).not.toContain('AuthService');
  });

  it('returns not-found message for unmatched filePattern', async () => {
    await writeCacheFixture(testDir, makeCallGraph(), makeSignatures());
    const r = await handleGetSignatures(testDir, 'no-such-pattern');
    expect(r).toMatch(/No files matching pattern/);
  });

  it('returns all files when no filePattern is given', async () => {
    await writeCacheFixture(testDir, makeCallGraph(), makeSignatures());
    const r = await handleGetSignatures(testDir);
    expect(r).toContain('routes.ts');
    expect(r).toContain('auth.ts');
  });
});

// ============================================================================
// handleGetMapping
// ============================================================================

describe('handleGetMapping', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-map-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no mapping.json exists', async () => {
    const r = await handleGetMapping(testDir) as { error: string };
    expect(r.error).toMatch(/openlore generate first/);
  });

  it('returns full mapping when no filters applied', async () => {
    await writeMappingFixture(testDir, makeMapping());
    const r = await handleGetMapping(testDir) as { mappings: unknown[]; orphanFunctions: unknown[] };
    expect(r.mappings).toHaveLength(2);
    expect(r.orphanFunctions).toHaveLength(1);
  });

  it('filters mappings by domain', async () => {
    await writeMappingFixture(testDir, makeMapping());
    const r = await handleGetMapping(testDir, 'auth') as { mappings: Array<{ domain: string }> };
    expect(r.mappings).toHaveLength(1);
    expect(r.mappings[0].domain).toBe('auth');
  });

  it('domain filter returns empty orphanFunctions', async () => {
    await writeMappingFixture(testDir, makeMapping());
    const r = await handleGetMapping(testDir, 'auth') as { orphanFunctions: unknown[] };
    expect(r.orphanFunctions).toHaveLength(0);
  });

  it('orphansOnly returns only orphan functions', async () => {
    await writeMappingFixture(testDir, makeMapping());
    const r = await handleGetMapping(testDir, undefined, true) as { orphanFunctions: Array<{ name: string }> };
    expect(r).toHaveProperty('orphanFunctions');
    expect(r.orphanFunctions[0].name).toBe('oldHelper');
    expect(r).not.toHaveProperty('mappings');
  });

  it('orphansOnly with domain filters orphans by file path containing domain', async () => {
    await writeMappingFixture(testDir, makeMapping());
    const r = await handleGetMapping(testDir, 'legacy', true) as { orphanFunctions: Array<{ name: string }> };
    expect(r.orphanFunctions).toHaveLength(1);
    expect(r.orphanFunctions[0].name).toBe('oldHelper');
  });

  it('orphansOnly with non-matching domain returns empty list', async () => {
    await writeMappingFixture(testDir, makeMapping());
    const r = await handleGetMapping(testDir, 'payments', true) as { orphanFunctions: unknown[] };
    expect(r.orphanFunctions).toHaveLength(0);
  });
});

// ============================================================================
// handleGetSubgraph
// ============================================================================

describe('handleGetSubgraph', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-subgraph-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await handleGetSubgraph(testDir, 'hub') as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns error when symbol not found', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetSubgraph(testDir, 'nonexistent') as { error: string };
    expect(r.error).toMatch(/No function matching/);
  });

  it('json format: returns nodes and edges for hub downstream', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetSubgraph(testDir, 'hub', 'downstream') as {
      nodes: Array<{ name: string }>; edges: unknown[]; stats: { nodes: number; edges: number };
    };
    const names = r.nodes.map(n => n.name);
    expect(names).toContain('hub');
    expect(names).toContain('workerA');
    expect(names).toContain('workerB');
    expect(names).toContain('util');
    expect(names).not.toContain('entry'); // upstream, excluded
  });

  it('json format: upstream direction returns callers', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetSubgraph(testDir, 'hub', 'upstream') as { nodes: Array<{ name: string }> };
    const names = r.nodes.map(n => n.name);
    expect(names).toContain('entry');
    expect(names).not.toContain('workerA');
  });

  it('json format: both direction returns callers and callees', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetSubgraph(testDir, 'hub', 'both') as { nodes: Array<{ name: string }> };
    const names = r.nodes.map(n => n.name);
    expect(names).toContain('entry');
    expect(names).toContain('workerA');
    expect(names).toContain('hub');
  });

  it('seeds are marked with isSeed=true', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetSubgraph(testDir, 'hub', 'downstream') as {
      nodes: Array<{ name: string; isSeed: boolean }>;
    };
    const hub = r.nodes.find(n => n.name === 'hub');
    expect(hub?.isSeed).toBe(true);
    const worker = r.nodes.find(n => n.name === 'workerA');
    expect(worker?.isSeed).toBe(false);
  });

  it('mermaid format: returns a code-fenced mermaid string', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetSubgraph(testDir, 'hub', 'both', 3, 'mermaid') as string;
    expect(typeof r).toBe('string');
    expect(r).toContain('```mermaid');
    expect(r).toContain('flowchart LR');
    expect(r).toContain('classDef seed');
  });

  it('maxDepth=1 limits traversal to direct neighbours', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    // entry → hub → workers; with depth=1 from entry, should NOT reach workerA
    const r = await handleGetSubgraph(testDir, 'entry', 'downstream', 1) as {
      nodes: Array<{ name: string }>;
    };
    const names = r.nodes.map(n => n.name);
    expect(names).toContain('hub');
    expect(names).not.toContain('workerA');
  });

  it('stats reflect node and edge count in subgraph', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetSubgraph(testDir, 'hub', 'downstream') as {
      stats: { nodes: number; edges: number };
    };
    expect(r.stats.nodes).toBeGreaterThan(0);
    expect(r.stats.edges).toBeGreaterThan(0);
  });
});

// ============================================================================
// handleAnalyzeImpact
// ============================================================================

describe('handleAnalyzeImpact', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-impact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await handleAnalyzeImpact(testDir, 'hub') as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns error when symbol is not found', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'nonexistent') as { error: string };
    expect(r.error).toMatch(/No function matching/);
  });

  it('returns a single object (not matches[]) for a unique symbol', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'hub') as Record<string, unknown>;
    expect(r).not.toHaveProperty('matches');
    expect(r.symbol).toBe('hub');
  });

  it('returns matches[] when symbol matches multiple nodes', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'worker') as { matches: unknown[] };
    expect(r.matches).toHaveLength(2);
  });

  it('symbol matching is case-insensitive', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const a = await handleAnalyzeImpact(testDir, 'HUB') as { symbol: string };
    expect(a.symbol).toBe('hub');
  });

  it('reports correct fanIn and fanOut for hub', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'hub') as { metrics: { fanIn: number; fanOut: number } };
    expect(r.metrics.fanIn).toBe(1);
    expect(r.metrics.fanOut).toBe(3);
  });

  it('blast radius includes upstream and downstream nodes', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'hub') as {
      blastRadius: { total: number; upstream: number; downstream: number };
    };
    expect(r.blastRadius.upstream).toBe(1);   // entry
    expect(r.blastRadius.downstream).toBe(3); // workerA, workerB, util
    expect(r.blastRadius.total).toBe(4);
  });

  it('leaf node has zero blast radius', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'leaf') as { blastRadius: { total: number } };
    expect(r.blastRadius.total).toBe(0);
  });

  it('riskScore is capped at 100', async () => {
    const cg = makeCallGraph();
    cg.nodes[1].fanIn = 30; cg.nodes[1].fanOut = 30;
    await writeCacheFixture(testDir, cg);
    const r = await handleAnalyzeImpact(testDir, 'hub') as { riskScore: number };
    expect(r.riskScore).toBeLessThanOrEqual(100);
  });

  it('riskLevel is "low" for a leaf with no callers', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'leaf') as { riskLevel: string };
    expect(r.riskLevel).toBe('low');
  });

  it('riskLevel escalates for a heavily-called hub', async () => {
    const cg = makeCallGraph();
    cg.nodes[1].fanIn = 15;
    await writeCacheFixture(testDir, cg);
    const r = await handleAnalyzeImpact(testDir, 'hub') as { riskLevel: string };
    expect(['high', 'critical']).toContain(r.riskLevel);
  });

  it('depth=1 limits downstream traversal to 1 hop', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'entry', 1) as {
      downstreamCriticalPath: Array<{ name: string }>;
    };
    const names = r.downstreamCriticalPath.map(n => n.name);
    expect(names).toContain('hub');
    expect(names).not.toContain('workerA');
  });

  it('returns recommendedStrategy with approach and rationale', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleAnalyzeImpact(testDir, 'leaf') as {
      recommendedStrategy: { approach: string; rationale: string };
    };
    expect(r.recommendedStrategy).toHaveProperty('approach');
    expect(r.recommendedStrategy).toHaveProperty('rationale');
    expect(typeof r.recommendedStrategy.rationale).toBe('string');
  });
});

// ============================================================================
// handleGetLowRiskRefactorCandidates
// ============================================================================

describe('handleGetLowRiskRefactorCandidates', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-lowrisk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await handleGetLowRiskRefactorCandidates(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('excludes hub functions', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir) as { candidates: Array<{ name: string }> };
    expect(r.candidates.map(c => c.name)).not.toContain('hub');
  });

  it('excludes entry points', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir) as { candidates: Array<{ name: string }> };
    expect(r.candidates.map(c => c.name)).not.toContain('entry');
  });

  it('all candidates have fanIn <= 2', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir) as { candidates: Array<{ fanIn: number }> };
    for (const c of r.candidates) expect(c.fanIn).toBeLessThanOrEqual(2);
  });

  it('respects the limit parameter', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir, 1) as {
      candidates: unknown[]; returned: number;
    };
    expect(r.candidates).toHaveLength(1);
    expect(r.returned).toBe(1);
  });

  it('filters by filePattern', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir, 5, 'workers') as {
      candidates: Array<{ file: string }>;
    };
    for (const c of r.candidates) expect(c.file).toContain('workers');
  });

  it('filePattern with no match returns empty candidates', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir, 5, 'no-such-path') as {
      candidates: unknown[]; total: number;
    };
    expect(r.candidates).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it('candidates are sorted by ascending fanIn+fanOut', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir, 10) as {
      candidates: Array<{ fanIn: number; fanOut: number }>;
    };
    for (let i = 1; i < r.candidates.length; i++) {
      const prev = r.candidates[i - 1].fanIn + r.candidates[i - 1].fanOut;
      const curr = r.candidates[i].fanIn    + r.candidates[i].fanOut;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  it('each candidate has a riskScore in [0, 100]', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLowRiskRefactorCandidates(testDir) as {
      candidates: Array<{ riskScore: number }>;
    };
    for (const c of r.candidates) {
      expect(c.riskScore).toBeGreaterThanOrEqual(0);
      expect(c.riskScore).toBeLessThanOrEqual(100);
    }
  });
});

// ============================================================================
// handleGetLeafFunctions
// ============================================================================

describe('handleGetLeafFunctions', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-leaves-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await handleGetLeafFunctions(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns only nodes with no outgoing edges', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir) as { leaves: Array<{ name: string }> };
    const names = r.leaves.map(l => l.name);
    expect(names).toContain('workerA');
    expect(names).toContain('workerB');
    expect(names).toContain('leaf');
    expect(names).toContain('util');
    expect(names).not.toContain('hub');
    expect(names).not.toContain('entry');
  });

  it('flags fanIn=0 leaves as dead code', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir) as {
      leaves: Array<{ name: string; refactorAdvice: string }>;
    };
    expect(r.leaves.find(l => l.name === 'leaf')?.refactorAdvice).toMatch(/dead code/);
  });

  it('marks called leaves with "Pure leaf" advice', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir) as {
      leaves: Array<{ name: string; refactorAdvice: string }>;
    };
    expect(r.leaves.find(l => l.name === 'util')?.refactorAdvice).toMatch(/Pure leaf/);
  });

  it('sortBy fanIn: most-called leaves first', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir, 20, undefined, 'fanIn') as {
      leaves: Array<{ fanIn: number }>;
    };
    for (let i = 1; i < r.leaves.length; i++)
      expect(r.leaves[i - 1].fanIn).toBeGreaterThanOrEqual(r.leaves[i].fanIn);
  });

  it('sortBy name: alphabetical order', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir, 20, undefined, 'name') as {
      leaves: Array<{ name: string }>;
    };
    const names = r.leaves.map(l => l.name);
    expect(names).toEqual([...names].sort());
  });

  it('sortBy file: grouped by file path', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir, 20, undefined, 'file') as {
      leaves: Array<{ file: string }>;
    };
    const files = r.leaves.map(l => l.file);
    for (let i = 1; i < files.length; i++)
      expect(files[i].localeCompare(files[i - 1])).toBeGreaterThanOrEqual(0);
  });

  it('respects the limit parameter', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir, 2) as { leaves: unknown[]; returned: number };
    expect(r.leaves).toHaveLength(2);
    expect(r.returned).toBe(2);
  });

  it('filters by filePattern', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir, 20, 'workers') as {
      leaves: Array<{ file: string }>;
    };
    for (const l of r.leaves) expect(l.file).toContain('workers');
  });

  it('totalLeaves matches actual leaf count (4 in fixture)', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetLeafFunctions(testDir) as { totalLeaves: number };
    expect(r.totalLeaves).toBe(4);
  });
});

// ============================================================================
// handleGetCriticalHubs
// ============================================================================

describe('handleGetCriticalHubs', () => {
  let testDir: string;
  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-hubs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it('returns error when no cache exists', async () => {
    const r = await handleGetCriticalHubs(testDir) as { error: string };
    expect(r.error).toMatch(/analyze_codebase first/);
  });

  it('returns empty list when no node meets minFanIn', async () => {
    await writeCacheFixture(testDir, makeCallGraph());
    const r = await handleGetCriticalHubs(testDir, 10, 99) as { hubs: unknown[]; totalHubs: number };
    expect(r.hubs).toHaveLength(0);
    expect(r.totalHubs).toBe(0);
  });

  it('respects minFanIn threshold', async () => {
    const cg = makeCallGraph();
    cg.nodes[1].fanIn = 5;
    await writeCacheFixture(testDir, cg);
    const with3 = await handleGetCriticalHubs(testDir, 10, 3) as { hubs: Array<{ name: string }> };
    const with6 = await handleGetCriticalHubs(testDir, 10, 6) as { hubs: Array<{ name: string }> };
    expect(with3.hubs.map(h => h.name)).toContain('hub');
    expect(with6.hubs.map(h => h.name)).not.toContain('hub');
  });

  it('hubs are sorted by descending criticality', async () => {
    const cg = makeCallGraph();
    cg.nodes.push(makeNode({ id: 'f7', name: 'bigHub', filePath: 'src/core/big.ts', fanIn: 10, fanOut: 8 }));
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 10, 1) as { hubs: Array<{ criticality: number }> };
    for (let i = 1; i < r.hubs.length; i++)
      expect(r.hubs[i - 1].criticality).toBeGreaterThanOrEqual(r.hubs[i].criticality);
  });

  it('respects the limit parameter', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 5;
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 1, 1) as { hubs: unknown[] };
    expect(r.hubs).toHaveLength(1);
  });

  it('approach "split responsibility" when fanIn>=8 AND fanOut>=5', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 8; cg.nodes[1].fanOut = 5;
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 10, 1) as {
      hubs: Array<{ name: string; recommendedApproach: { approach: string } }>;
    };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('split responsibility');
  });

  it('approach "introduce façade" when fanIn>=8 AND fanOut<5', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 8; cg.nodes[1].fanOut = 2;
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 10, 1) as {
      hubs: Array<{ name: string; recommendedApproach: { approach: string } }>;
    };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('introduce façade');
  });

  it('approach "delegate" when fanIn<8 AND fanOut>=5', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 5;
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 10, 1) as {
      hubs: Array<{ name: string; recommendedApproach: { approach: string } }>;
    };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('delegate');
  });

  it('approach "extract" for moderate hub (fanIn<8, fanOut<5)', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 2;
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 10, 1) as {
      hubs: Array<{ name: string; recommendedApproach: { approach: string } }>;
    };
    expect(r.hubs.find(h => h.name === 'hub')?.recommendedApproach.approach).toBe('extract');
  });

  it('criticality adds +10 for layer violation files', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 2;
    cg.layerViolations = [{ callerId: 'f2', calleeId: 'f3', callerLayer: 'api', calleeLayer: 'storage', reason: 'test' }];
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 10, 1) as {
      hubs: Array<{ name: string; criticality: number; hasLayerViolation: boolean }>;
    };
    const hub = r.hubs.find(h => h.name === 'hub')!;
    expect(hub.hasLayerViolation).toBe(true);
    expect(hub.criticality).toBe(25); // 4*3 + 2*1.5 + 10 = 25
  });

  it('stabilityScore = max(0, round(100 - criticality))', async () => {
    const cg = makeCallGraph(); cg.nodes[1].fanIn = 4; cg.nodes[1].fanOut = 2;
    await writeCacheFixture(testDir, cg);
    const r = await handleGetCriticalHubs(testDir, 10, 1) as {
      hubs: Array<{ criticality: number; stabilityScore: number }>;
    };
    for (const h of r.hubs) {
      expect(h.stabilityScore).toBe(Math.max(0, Math.round(100 - Math.min(100, h.criticality))));
      expect(h.stabilityScore).toBeGreaterThanOrEqual(0);
      expect(h.stabilityScore).toBeLessThanOrEqual(100);
    }
  });
});

// ============================================================================
// handleCheckSpecDrift
// ============================================================================

function makeDriftResult(overrides: Partial<DriftResult> = {}): DriftResult {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    baseRef: 'main',
    totalChangedFiles: 1,
    specRelevantFiles: 1,
    issues: [],
    summary: { gaps: 0, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, memoryOutOfScope: 0, total: 0 },
    hasDrift: false,
    duration: 42,
    mode: 'static',
    ...overrides,
  };
}

describe('handleCheckSpecDrift', () => {
  let driftDir: string;

  beforeEach(async () => {
    driftDir = join(tmpdir(), `mcp-drift-${Date.now()}`);
    await mkdir(driftDir, { recursive: true });
    vi.mocked(isGitRepository).mockReset();
    vi.mocked(readOpenLoreConfig).mockReset();
    vi.mocked(getChangedFiles).mockReset();
    vi.mocked(buildSpecMap).mockReset();
    vi.mocked(buildADRMap).mockReset();
    vi.mocked(detectDrift).mockReset();
  });

  afterEach(async () => {
    await rm(driftDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('throws when directory does not exist', async () => {
    await expect(handleCheckSpecDrift('/nonexistent/mcp-drift-test-00000'))
      .rejects.toThrow('not found');
  });

  it('returns error when not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(false);
    const result = await handleCheckSpecDrift(driftDir);
    expect(result).toMatchObject({ error: expect.stringContaining('git') });
  });

  it('returns error when no openlore config found', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null);
    const result = await handleCheckSpecDrift(driftDir);
    expect(result).toMatchObject({ error: expect.stringContaining('openlore init') });
  });

  it('returns error when no specs directory exists', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(true);
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as any);
    // openspec/specs does NOT exist in driftDir → stat throws
    const result = await handleCheckSpecDrift(driftDir);
    expect(result).toMatchObject({ error: expect.stringContaining('openlore generate') });
  });

  it('returns empty DriftResult when no files changed', async () => {
    await mkdir(join(driftDir, 'openspec', 'specs'), { recursive: true });
    vi.mocked(isGitRepository).mockResolvedValue(true);
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as any);
    vi.mocked(getChangedFiles).mockResolvedValue(
      { files: [], resolvedBase: 'main', currentBranch: 'feature' } as any  
    );
    const result = await handleCheckSpecDrift(driftDir) as DriftResult;
    expect(result.hasDrift).toBe(false);
    expect(result.totalChangedFiles).toBe(0);
    expect(result.mode).toBe('static');
    expect(result.issues).toHaveLength(0);
  });

  it('returns DriftResult with no issues when no drift', async () => {
    await mkdir(join(driftDir, 'openspec', 'specs'), { recursive: true });
    vi.mocked(isGitRepository).mockResolvedValue(true);
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as any);
    vi.mocked(getChangedFiles).mockResolvedValue(
      { files: [{ path: 'src/auth.ts', status: 'modified', additions: 5, deletions: 1, isTest: false }], resolvedBase: 'main', currentBranch: 'feature' } as any  
    );
    vi.mocked(buildSpecMap).mockResolvedValue({ domainCount: 1, totalMappedFiles: 3 } as any);  
    vi.mocked(buildADRMap).mockResolvedValue(null);
    vi.mocked(detectDrift).mockResolvedValue(makeDriftResult());
    const result = await handleCheckSpecDrift(driftDir) as DriftResult;
    expect(result.hasDrift).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it('returns DriftResult with issues when drift detected', async () => {
    await mkdir(join(driftDir, 'openspec', 'specs'), { recursive: true });
    vi.mocked(isGitRepository).mockResolvedValue(true);
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as any);
    vi.mocked(getChangedFiles).mockResolvedValue(
      { files: [{ path: 'src/auth.ts', status: 'modified', additions: 20, deletions: 5, isTest: false }], resolvedBase: 'main', currentBranch: 'feature' } as any  
    );
    vi.mocked(buildSpecMap).mockResolvedValue({ domainCount: 1, totalMappedFiles: 3 } as any);  
    vi.mocked(buildADRMap).mockResolvedValue(null);
    vi.mocked(detectDrift).mockResolvedValue(makeDriftResult({
      hasDrift: true,
      issues: [{
        id: 'gap-1', kind: 'gap', severity: 'warning',
        message: 'auth.ts changed but auth spec not updated',
        filePath: 'src/auth.ts', domain: 'auth', specPath: 'openspec/specs/auth/spec.md',
        changedLines: { added: 20, removed: 5 },
        suggestion: 'Update the auth spec to reflect these changes',
      }],
      summary: { gaps: 1, stale: 0, uncovered: 0, orphanedSpecs: 0, adrGaps: 0, adrOrphaned: 0, memoryDrifted: 0, memoryOrphaned: 0, memoryOutOfScope: 0, total: 1 },
      totalChangedFiles: 1,
    }));
    const result = await handleCheckSpecDrift(driftDir) as DriftResult;
    expect(result.hasDrift).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].kind).toBe('gap');
    expect(result.summary.gaps).toBe(1);
    expect(result.summary.total).toBe(1);
  });

  it('passes base, domains, failOn to detectDrift', async () => {
    await mkdir(join(driftDir, 'openspec', 'specs'), { recursive: true });
    vi.mocked(isGitRepository).mockResolvedValue(true);
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as any);
    vi.mocked(getChangedFiles).mockResolvedValue(
      { files: [{ path: 'src/orders.ts', status: 'modified', additions: 1, deletions: 0, isTest: false }], resolvedBase: 'develop', currentBranch: 'feature' } as any  
    );
    vi.mocked(buildSpecMap).mockResolvedValue({ domainCount: 1, totalMappedFiles: 2 } as any);  
    vi.mocked(buildADRMap).mockResolvedValue(null);
    vi.mocked(detectDrift).mockResolvedValue(makeDriftResult());
    await handleCheckSpecDrift(driftDir, 'develop', [], ['orders'], 'error');
    expect(vi.mocked(getChangedFiles)).toHaveBeenCalledWith(
      expect.objectContaining({ baseRef: 'develop' })
    );
    expect(vi.mocked(detectDrift)).toHaveBeenCalledWith(
      expect.objectContaining({ failOn: 'error', domainFilter: ['orders'] })
    );
  });

  it('truncates files list when exceeding maxFiles', async () => {
    await mkdir(join(driftDir, 'openspec', 'specs'), { recursive: true });
    vi.mocked(isGitRepository).mockResolvedValue(true);
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as any);
    const manyFiles = Array.from({ length: 10 }, (_, i) => ({
      path: `src/file${i}.ts`, status: 'modified', additions: 1, deletions: 0, isTest: false,
    }));
    vi.mocked(getChangedFiles).mockResolvedValue(
      { files: manyFiles, resolvedBase: 'main', currentBranch: 'feat' } as any  
    );
    vi.mocked(buildSpecMap).mockResolvedValue({ domainCount: 1, totalMappedFiles: 5 } as any);  
    vi.mocked(buildADRMap).mockResolvedValue(null);
    vi.mocked(detectDrift).mockResolvedValue(makeDriftResult({ totalChangedFiles: 10 }));
    // maxFiles = 3 → detectDrift receives only 3 files
    await handleCheckSpecDrift(driftDir, 'auto', [], [], 'warning', 3);
    const callArg = vi.mocked(detectDrift).mock.calls[0][0];
    expect(callArg.changedFiles).toHaveLength(3);
  });

  it('sets totalChangedFiles to actual count (before truncation)', async () => {
    await mkdir(join(driftDir, 'openspec', 'specs'), { recursive: true });
    vi.mocked(isGitRepository).mockResolvedValue(true);
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ openspecPath: 'openspec' } as any);
    const manyFiles = Array.from({ length: 5 }, (_, i) => ({
      path: `src/file${i}.ts`, status: 'modified', additions: 1, deletions: 0, isTest: false,
    }));
    vi.mocked(getChangedFiles).mockResolvedValue(
      { files: manyFiles, resolvedBase: 'main', currentBranch: 'feat' } as any  
    );
    vi.mocked(buildSpecMap).mockResolvedValue({ domainCount: 1, totalMappedFiles: 5 } as any);  
    vi.mocked(buildADRMap).mockResolvedValue(null);
    vi.mocked(detectDrift).mockResolvedValue(makeDriftResult());
    const result = await handleCheckSpecDrift(driftDir, 'auto', [], [], 'warning', 2) as DriftResult;
    // totalChangedFiles should reflect the original 5, not the truncated 2
    expect(result.totalChangedFiles).toBe(5);
  });
});

// ============================================================================
// handleSuggestInsertionPoints
// ============================================================================

/** Minimal SearchResult shape returned by VectorIndex.search */
function makeFakeResult(
  name: string,
  distance: number,
  opts: { fanIn?: number; fanOut?: number; isHub?: boolean; isEntryPoint?: boolean } = {}
) {
  return {
    score: distance,
    record: {
      id: `id-${name}`,
      name,
      filePath: `src/${name}.ts`,
      className: '',
      language: 'TypeScript',
      signature: `function ${name}(): void`,
      docstring: '',
      fanIn: opts.fanIn ?? 1,
      fanOut: opts.fanOut ?? 1,
      isHub: opts.isHub ?? false,
      isEntryPoint: opts.isEntryPoint ?? false,
      text: name,
    },
  };
}

describe('handleSuggestInsertionPoints', () => {
  let testDir: string;
  const mockEmbedSvc = { embed: vi.fn() };

  beforeEach(async () => {
    testDir = join(tmpdir(), `mcp-suggest-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(EmbeddingService.fromEnv).mockReturnValue(mockEmbedSvc as never);
    vi.mocked(VectorIndex.search).mockResolvedValue([]);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('throws when directory does not exist', async () => {
    await expect(handleSuggestInsertionPoints('/nonexistent/suggest-test-00000', 'add retry'))
      .rejects.toThrow('not found');
  });

  it('returns error when no vector index exists', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(false);
    const result = await handleSuggestInsertionPoints(testDir, 'add retry') as { error: string };
    expect(result.error).toMatch(/No search index found/);
  });

  it('falls back to BM25 (no error) when embedding config not found', async () => {
    vi.mocked(EmbeddingService.fromEnv).mockImplementation(() => { throw new Error('no env'); });
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null);
    vi.mocked(VectorIndex.search).mockResolvedValue([]);
    const result = await handleSuggestInsertionPoints(testDir, 'add retry') as { error?: string; candidates: unknown[] };
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.candidates)).toBe(true);
    // embedSvc resolved to null → search called with a null embedder (BM25 path)
    expect(VectorIndex.search).toHaveBeenCalledWith(expect.any(String), 'add retry', null, expect.anything());
  });

  it('returns empty candidates when search returns no results', async () => {
    vi.mocked(VectorIndex.search).mockResolvedValue([]);
    const result = await handleSuggestInsertionPoints(testDir, 'add retry') as { count: number; candidates: unknown[] };
    expect(result.count).toBe(0);
    expect(result.candidates).toHaveLength(0);
  });

  it('classifies entry_point role and extend_entry_point strategy', async () => {
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeFakeResult('startCrawler', 0.1, { isEntryPoint: true, fanIn: 0, fanOut: 3 }),
    ]);
    const result = await handleSuggestInsertionPoints(testDir, 'start crawling') as { candidates: Array<{ role: string; insertionStrategy: string }> };
    expect(result.candidates[0].role).toBe('entry_point');
    expect(result.candidates[0].insertionStrategy).toBe('extend_entry_point');
  });

  it('classifies orchestrator role and add_orchestration_step strategy', async () => {
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeFakeResult('processRequest', 0.15, { fanOut: 8 }),
    ]);
    const result = await handleSuggestInsertionPoints(testDir, 'process incoming request') as { candidates: Array<{ role: string }> };
    expect(result.candidates[0].role).toBe('orchestrator');
  });

  it('classifies hub role for high fanIn functions', async () => {
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeFakeResult('logger', 0.2, { isHub: true, fanIn: 50 }),
    ]);
    const result = await handleSuggestInsertionPoints(testDir, 'add logging') as { candidates: Array<{ role: string }> };
    expect(result.candidates[0].role).toBe('hub');
  });

  it('re-ranks by composite score — entry_point beats internal even with worse semantic distance', async () => {
    // internal: distance 0.05 (very close semantically), but low structural value
    // entry_point: distance 0.25 (farther), but high structural value
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeFakeResult('internalHelper', 0.05, { fanIn: 2, fanOut: 1, isEntryPoint: false }),
      makeFakeResult('startFeature', 0.25, { fanIn: 0, fanOut: 2, isEntryPoint: true }),
    ]);
    const result = await handleSuggestInsertionPoints(testDir, 'start new feature') as { candidates: Array<{ name: string }> };
    // composite(internalHelper) = 0.95*0.6 + 0.4*0.4 = 0.57+0.16 = 0.73
    // composite(startFeature) = 0.75*0.6 + 1.0*0.4 = 0.45+0.40 = 0.85 → ranked first
    expect(result.candidates[0].name).toBe('startFeature');
    expect(result.candidates[1].name).toBe('internalHelper');
  });

  it('respects limit parameter', async () => {
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeFakeResult('fn1', 0.1),
      makeFakeResult('fn2', 0.15),
      makeFakeResult('fn3', 0.2),
    ]);
    const result = await handleSuggestInsertionPoints(testDir, 'feature', 2) as { candidates: unknown[] };
    expect(result.candidates).toHaveLength(2);
  });

  it('assigns sequential rank starting at 1', async () => {
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeFakeResult('fnA', 0.1),
      makeFakeResult('fnB', 0.2),
    ]);
    const result = await handleSuggestInsertionPoints(testDir, 'feature') as { candidates: Array<{ rank: number }> };
    expect(result.candidates[0].rank).toBe(1);
    expect(result.candidates[1].rank).toBe(2);
  });

  it('includes nextSteps with top candidate name when results found', async () => {
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeFakeResult('fetchPage', 0.1, { isEntryPoint: true }),
    ]);
    const result = await handleSuggestInsertionPoints(testDir, 'add retry for HTTP') as { nextSteps: string[] };
    expect(result.nextSteps.some(s => s.includes('fetchPage'))).toBe(true);
  });

  it('falls back to fromConfig when fromEnv throws', async () => {
    vi.mocked(EmbeddingService.fromEnv).mockImplementation(() => { throw new Error('no env'); });
     
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ embedding: { baseUrl: 'http://x', model: 'm' } } as any);
    vi.mocked(EmbeddingService.fromConfig).mockReturnValue(mockEmbedSvc as never);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeFakeResult('fn', 0.1)]);
    const result = await handleSuggestInsertionPoints(testDir, 'feature') as { count: number };
    expect(result.count).toBe(1);
    expect(EmbeddingService.fromConfig).toHaveBeenCalled();
  });
});

// ============================================================================
// handleGetArchitectureOverview
// ============================================================================

describe('handleGetArchitectureOverview', () => {
  let testDir: string;

  // Minimal dep-graph fixture
  const makeDepGraph = (overrides?: object) => ({
    nodes: [
      { file: { path: '/abs/src/cli/index.ts' }, metrics: { inDegree: 0, outDegree: 3 } },
      { file: { path: '/abs/src/core/foo.ts' }, metrics: { inDegree: 2, outDegree: 1 } },
    ],
    edges: [
      { source: '/abs/src/cli/index.ts', target: '/abs/src/core/foo.ts' },
    ],
    clusters: [
      { id: 'cl-cli', name: 'CLI', files: ['/abs/src/cli/index.ts'] },
      { id: 'cl-core', name: 'Core', files: ['/abs/src/core/foo.ts'] },
    ],
    cycles: [],
    statistics: { nodeCount: 2, edgeCount: 1 },
    ...overrides,
  });

  // Minimal llm-context fixture (with call graph)
  const makeCtx = (overrides?: object) => ({
    callGraph: {
      entryPoints: [{ name: 'main', filePath: 'src/cli/index.ts', language: 'TypeScript', fanIn: 0, fanOut: 3 }],
      hubFunctions: [{ name: 'process', filePath: 'src/core/foo.ts', language: 'TypeScript', fanIn: 5, fanOut: 2 }],
      layerViolations: [],
    },
    ...overrides,
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mcp-arch-test-'));
    await mkdir(join(testDir, '.openlore', 'analysis'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('throws McpError when directory does not exist', async () => {
    await expect(handleGetArchitectureOverview('/nonexistent/path')).rejects.toThrow();
  });

  it('returns error when no analysis files found', async () => {
    const result = await handleGetArchitectureOverview(testDir) as { error: string };
    expect(result.error).toMatch(/No analysis found/);
  });

  it('returns summary stats from dep-graph', async () => {
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph()),
      'utf-8'
    );
    const result = await handleGetArchitectureOverview(testDir) as {
      summary: { totalFiles: number; totalClusters: number; totalEdges: number };
    };
    expect(result.summary.totalFiles).toBe(2);
    expect(result.summary.totalClusters).toBe(2);
    expect(result.summary.totalEdges).toBe(1);
  });

  it('identifies entry_layer role for cluster containing entry points', async () => {
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph()),
      'utf-8'
    );
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'llm-context.json'),
      JSON.stringify(makeCtx()),
      'utf-8'
    );
    // absDir for testDir, so toRel strips testDir prefix from absolute paths.
    // But our fixture uses '/abs/...' which is not under testDir →
    // hub/entry lookup is done via relative paths from llm-context,
    // while cluster files are absolute '/abs/...' which won't match testDir prefix.
    // Use testDir-based absolute paths to exercise the path normalization.
    const depGraph = makeDepGraph({
      nodes: [
        { file: { path: join(testDir, 'src/cli/index.ts') }, metrics: { inDegree: 0, outDegree: 3 } },
        { file: { path: join(testDir, 'src/core/foo.ts') }, metrics: { inDegree: 2, outDegree: 1 } },
      ],
      edges: [{ source: join(testDir, 'src/cli/index.ts'), target: join(testDir, 'src/core/foo.ts') }],
      clusters: [
        { id: 'cl-cli', name: 'CLI', files: [join(testDir, 'src/cli/index.ts')] },
        { id: 'cl-core', name: 'Core', files: [join(testDir, 'src/core/foo.ts')] },
      ],
    });
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'dependency-graph.json'),
      JSON.stringify(depGraph),
      'utf-8'
    );
    const ctx = makeCtx({
      callGraph: {
        entryPoints: [{ name: 'main', filePath: 'src/cli/index.ts', language: 'TypeScript', fanIn: 0, fanOut: 3 }],
        hubFunctions: [],
        layerViolations: [],
      },
    });
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'llm-context.json'),
      JSON.stringify(ctx),
      'utf-8'
    );
    const result = await handleGetArchitectureOverview(testDir) as {
      clusters: Array<{ id: string; role: string }>;
    };
    const cli = result.clusters.find(c => c.id === 'cl-cli');
    expect(cli?.role).toBe('entry_layer');
  });

  it('builds inter-cluster dependencies', async () => {
    const depGraph = makeDepGraph({
      nodes: [
        { file: { path: join(testDir, 'src/cli/index.ts') }, metrics: { inDegree: 0, outDegree: 1 } },
        { file: { path: join(testDir, 'src/core/foo.ts') }, metrics: { inDegree: 1, outDegree: 0 } },
      ],
      edges: [{ source: join(testDir, 'src/cli/index.ts'), target: join(testDir, 'src/core/foo.ts') }],
      clusters: [
        { id: 'cl-cli', name: 'CLI', files: [join(testDir, 'src/cli/index.ts')] },
        { id: 'cl-core', name: 'Core', files: [join(testDir, 'src/core/foo.ts')] },
      ],
    });
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'dependency-graph.json'),
      JSON.stringify(depGraph),
      'utf-8'
    );
    const result = await handleGetArchitectureOverview(testDir) as {
      clusters: Array<{ id: string; dependsOn: string[] }>;
    };
    const cli = result.clusters.find(c => c.id === 'cl-cli');
    expect(cli?.dependsOn).toContain('cl-core');
    const core = result.clusters.find(c => c.id === 'cl-core');
    expect(core?.dependsOn).toHaveLength(0);
  });

  it('works with only llm-context (no dep-graph)', async () => {
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'llm-context.json'),
      JSON.stringify(makeCtx()),
      'utf-8'
    );
    const result = await handleGetArchitectureOverview(testDir) as {
      summary: { totalFiles: number; totalClusters: number };
      globalEntryPoints: Array<{ name: string }>;
    };
    expect(result.summary.totalFiles).toBe(0);
    expect(result.summary.totalClusters).toBe(0);
    expect(result.globalEntryPoints[0].name).toBe('main');
  });

  it('clusters sorted by fileCount descending', async () => {
    const depGraph = makeDepGraph({
      nodes: [],
      edges: [],
      clusters: [
        { id: 'small', name: 'Small', files: ['a.ts'] },
        { id: 'big', name: 'Big', files: ['b.ts', 'c.ts', 'd.ts'] },
      ],
      statistics: { nodeCount: 4, edgeCount: 0 },
    });
    await writeFile(
      join(testDir, '.openlore', 'analysis', 'dependency-graph.json'),
      JSON.stringify(depGraph),
      'utf-8'
    );
    const result = await handleGetArchitectureOverview(testDir) as {
      clusters: Array<{ id: string }>;
    };
    expect(result.clusters[0].id).toBe('big');
    expect(result.clusters[1].id).toBe('small');
  });
});
