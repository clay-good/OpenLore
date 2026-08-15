/**
 * Integration tests for openloreGenerate() — RAG pipeline wiring
 *
 * These tests exercise the full generate pipeline on a minimal fixture project
 * built in a tmpdir. They catch wiring bugs that unit tests miss: e.g., the
 * mapping running *after* formatting, the CLI command not receiving depGraph,
 * or rag-manifest.json not being written.
 *
 * Mocked:
 *   - SpecGenerationPipeline.run() → returns a minimal PipelineResult
 *   - LLM service creation (no real API key needed)
 *   - logger (suppress output)
 *
 * NOT mocked:
 *   - OpenSpecFormatGenerator (generates actual spec content)
 *   - MappingGenerator (generates actual mapping artifact)
 *   - RagManifestGenerator (writes actual rag-manifest.json)
 *   - OpenSpecWriter (writes actual .md files)
 *   - All file I/O (real tmpdir)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================================
// MOCKS — must be hoisted before any dynamic imports
// ============================================================================

vi.mock('../utils/logger.js', () => {
  const stub = {
    section: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
    success: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn(),
  };
  return { logger: stub, default: stub, configureLogger: vi.fn() };
});

// Mock the LLM service factory — no real API key needed
vi.mock('../core/services/llm-service.js', () => ({
  createLLMService: vi.fn(() => ({
    chat: vi.fn(),
    estimateTokens: vi.fn(() => 0),
    saveLogs: vi.fn(async () => {}),
  })),
}));

// Mock SpecGenerationPipeline.run() to skip LLM calls
vi.mock('../core/generator/spec-pipeline.js', () => ({
  SpecGenerationPipeline: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      run: vi.fn().mockResolvedValue(makePipelineResult()),
    });
  }),
}));

// MappingGenerator: let it run but return no mapping to keep the test simple
// (a separate test covers the > Implementation: annotation)
// We selectively override only in tests that need it.

// ============================================================================
// FIXTURE HELPERS
// ============================================================================

function makePipelineResult() {
  return {
    survey: {
      projectCategory: 'cli-tool' as const,
      primaryLanguage: 'TypeScript',
      frameworks: [],
      architecturePattern: 'layered' as const,
      domainSummary: 'A test project.',
      suggestedDomains: ['generator', 'analyzer'],
      confidence: 0.9,
      schemaFiles: [],
      serviceFiles: [],
      apiFiles: [],
    },
    entities: [],
    services: [
      {
        name: 'GeneratorService',
        purpose: 'Generates output files.',
        operations: [
          {
            name: 'GenerateOutput',
            description: 'Generates the output.',
            scenarios: [{ name: 'HappyPath', given: 'valid input', when: 'called', then: 'output is written' }],
          },
        ],
        dependencies: ['analyzer'],
        sideEffects: [],
        domain: 'generator',
      },
      {
        name: 'AnalyzerService',
        purpose: 'Analyzes source files.',
        operations: [
          {
            name: 'AnalyzeFiles',
            description: 'Analyzes source.',
            scenarios: [{ name: 'HappyPath', given: 'source files', when: 'analyzed', then: 'graph produced' }],
          },
        ],
        dependencies: [],
        sideEffects: [],
        domain: 'analyzer',
      },
    ],
    endpoints: [],
    architecture: {
      systemPurpose: 'Test system.',
      architectureStyle: 'layered',
      layerMap: [],
      dataFlow: 'linear',
      integrations: [],
      securityModel: 'none',
      keyDecisions: [],
    },
    metadata: {
      totalTokens: 0,
      estimatedCost: 0,
      duration: 0,
      completedStages: ['stage1', 'stage2', 'stage5'],
      skippedStages: [],
    },
  };
}

/** Minimal RepoStructure artifact for the analyze output */
function makeRepoStructure() {
  return {
    projectName: 'test-project',
    projectType: 'nodejs',
    frameworks: [],
    architecture: { pattern: 'layered', layers: [] },
    domains: [],
    entryPoints: [],
    dataFlow: { inputs: [], outputs: [], transformations: [] },
    keyFiles: { config: [], schema: [], entry: [] },
    statistics: {
      totalFiles: 2,
      analyzedFiles: 2,
      skippedFiles: 0,
      avgFileScore: 1,
      nodeCount: 0,
      edgeCount: 0,
      cycleCount: 0,
      clusterCount: 2,
    },
  };
}

/** Minimal LLMContext artifact */
function makeLlmContext() {
  return {
    phase1_survey: { purpose: 'Survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'Deep', files: [], totalTokens: 0 },
    phase3_validation: { purpose: 'Validation', files: [], totalTokens: 0 },
  };
}

/** DependencyGraphResult with two clusters connected by an edge */
function makeDepGraph() {
  return {
    nodes: [
      {
        id: 'src/generator/gen.ts', label: 'gen.ts', type: 'file', size: 1, layer: 'generator',
        file: { path: 'src/generator/gen.ts' }, exports: [],
        metrics: { inDegree: 0, outDegree: 1, betweenness: 0, pageRank: 0 },
      },
      {
        id: 'src/analyzer/dep.ts', label: 'dep.ts', type: 'file', size: 1, layer: 'analyzer',
        file: { path: 'src/analyzer/dep.ts' }, exports: [],
        metrics: { inDegree: 1, outDegree: 0, betweenness: 0, pageRank: 0 },
      },
    ],
    edges: [
      {
        source: 'src/generator/gen.ts',
        target: 'src/analyzer/dep.ts',
        importedNames: ['AnalyzerResult'],
        isTypeOnly: false,
        weight: 1,
      },
    ],
    clusters: [
      {
        id: 'c1', name: 'generator',
        files: ['src/generator/gen.ts'],
        internalEdges: 0, externalEdges: 1,
        cohesion: 1.0, coupling: 0.5,
        isStructural: true,
        suggestedDomain: 'generator', color: '#0f0',
      },
      {
        id: 'c2', name: 'analyzer',
        files: ['src/analyzer/dep.ts'],
        internalEdges: 0, externalEdges: 1,
        cohesion: 1.0, coupling: 0.5,
        isStructural: true,
        suggestedDomain: 'analyzer', color: '#f00',
      },
    ],
    structuralClusters: [],
    cycles: [],
    rankings: {
      byImportance: [], byConnectivity: [], clusterCenters: [],
      leafNodes: [], bridgeNodes: [], orphanNodes: [],
    },
    statistics: {
      nodeCount: 2, edgeCount: 1,
      httpEdgeCount: 0, importEdgeCount: 1,
      avgDegree: 1, density: 0.5,
      clusterCount: 2, structuralClusterCount: 0,
      cycleCount: 0,
    },
  };
}

/** Minimal openlore config */
function makeOpenLoreConfig(openspecPath = './openspec') {
  return {
    version: '1.0.0',
    projectType: 'nodejs',
    openspecPath,
    analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
    generation: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', domains: 'auto' },
    createdAt: new Date().toISOString(),
    lastRun: null,
  };
}

/** Create a file and all parent directories */
async function createFile(dir: string, relPath: string, content: string): Promise<void> {
  const full = join(dir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

// ============================================================================
// TESTS
// ============================================================================

describe('openloreGenerate() integration — RAG pipeline wiring', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-gen-integration-'));

    // Set a fake API key so the key check passes
    process.env.ANTHROPIC_API_KEY = 'test-key-integration';

    // Write minimal project fixtures
    await createFile(tmpDir, '.openlore/config.json',
      JSON.stringify(makeOpenLoreConfig(), null, 2));

    // openspec config.yaml (readOpenSpecConfig tolerates missing file; create it for completeness)
    await createFile(tmpDir, 'openspec/config.yaml', 'schema: openspec/v1\n');

    // Analysis artifacts
    await createFile(tmpDir, '.openlore/analysis/repo-structure.json',
      JSON.stringify(makeRepoStructure(), null, 2));
    await createFile(tmpDir, '.openlore/analysis/llm-context.json',
      JSON.stringify(makeLlmContext(), null, 2));
    await createFile(tmpDir, '.openlore/analysis/dependency-graph.json',
      JSON.stringify(makeDepGraph(), null, 2));

    // Intermediate generation dir (writer may create it, but ensure parent exists)
    await mkdir(join(tmpDir, '.openlore', 'generation'), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Test 1 — rag-manifest.json is written and has correct domain entries
  // --------------------------------------------------------------------------
  it('writes rag-manifest.json with domain entries', async () => {
    const { openloreGenerate } = await import('./generate.js');
    await openloreGenerate({ rootPath: tmpDir });

    const manifestPath = join(tmpDir, 'openspec', 'rag-manifest.json');
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);

    expect(manifest).toHaveProperty('generatedAt');
    expect(manifest).toHaveProperty('specVersion');
    expect(Array.isArray(manifest.domains)).toBe(true);
    expect(manifest.domains.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Test 2 — cross-cluster edges populate dependsOn / calledBy
  // --------------------------------------------------------------------------
  it('populates dependsOn and calledBy from depGraph edges', async () => {
    const { openloreGenerate } = await import('./generate.js');
    await openloreGenerate({ rootPath: tmpDir });

    const manifestPath = join(tmpDir, 'openspec', 'rag-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));

    const genEntry = manifest.domains.find((d: { domain: string }) => d.domain === 'generator');
    const analyzerEntry = manifest.domains.find((d: { domain: string }) => d.domain === 'analyzer');

    // generator imports from analyzer → generator.dependsOn includes 'analyzer'
    expect(genEntry).toBeDefined();
    expect(genEntry.dependsOn).toContain('analyzer');
    expect(genEntry.calledBy).toEqual([]);

    // analyzer is imported by generator → analyzer.calledBy includes 'generator'
    expect(analyzerEntry).toBeDefined();
    expect(analyzerEntry.calledBy).toContain('generator');
    expect(analyzerEntry.dependsOn).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Test 3 — sourceFiles come from the matching cluster
  // --------------------------------------------------------------------------
  it('includes sourceFiles from the matching depGraph cluster', async () => {
    const { openloreGenerate } = await import('./generate.js');
    await openloreGenerate({ rootPath: tmpDir });

    const manifest = JSON.parse(
      await readFile(join(tmpDir, 'openspec', 'rag-manifest.json'), 'utf-8'));

    const genEntry = manifest.domains.find((d: { domain: string }) => d.domain === 'generator');
    expect(genEntry?.sourceFiles).toContain('src/generator/gen.ts');
  });

  // --------------------------------------------------------------------------
  // Test 4 — domain spec files are written to openspec/specs/<domain>/spec.md
  // --------------------------------------------------------------------------
  it('writes domain spec files for each discovered domain', async () => {
    const { openloreGenerate } = await import('./generate.js');
    await openloreGenerate({ rootPath: tmpDir });

    // At minimum an overview spec should be written
    const overviewPath = join(tmpDir, 'openspec', 'specs', 'overview', 'spec.md');
    const overviewContent = await readFile(overviewPath, 'utf-8');
    expect(overviewContent).toContain('# ');

    // Domain specs (generator and/or analyzer)
    const generatorPath = join(tmpDir, 'openspec', 'specs', 'generator', 'spec.md');
    const generatorContent = await readFile(generatorPath, 'utf-8');
    expect(generatorContent.length).toBeGreaterThan(10);
  });

  // --------------------------------------------------------------------------
  // Test 5 — ## Dependencies section is present when cross-cluster edges exist
  // --------------------------------------------------------------------------
  it('includes ## Dependencies section in domain specs when edges exist', async () => {
    const { openloreGenerate } = await import('./generate.js');
    await openloreGenerate({ rootPath: tmpDir });

    // generator → analyzer edge must produce a ## Dependencies section
    const generatorSpecPath = join(tmpDir, 'openspec', 'specs', 'generator', 'spec.md');
    const content = await readFile(generatorSpecPath, 'utf-8');
    expect(content).toContain('## Dependencies');
  });

  // --------------------------------------------------------------------------
  // Test 6 — report has filesWritten list
  // --------------------------------------------------------------------------
  it('returns a report with at least one written file', async () => {
    const { openloreGenerate } = await import('./generate.js');
    const result = await openloreGenerate({ rootPath: tmpDir });

    expect(result.report.filesWritten.length).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThan(0);
  });

  it('uses one configured custom OpenSpec destination for every generated artifact', async () => {
    await createFile(tmpDir, '.openlore/config.json',
      JSON.stringify(makeOpenLoreConfig('docs/open-spec'), null, 2));
    await createFile(tmpDir, 'docs/open-spec/config.yaml', 'schema: openspec/v1\n');
    const { openloreGenerate } = await import('./generate.js');
    await openloreGenerate({ rootPath: tmpDir });

    expect(await readFile(join(tmpDir, 'docs/open-spec/specs/overview/spec.md'), 'utf-8')).toContain('# ');
    expect(await readFile(join(tmpDir, 'docs/open-spec/rag-manifest.json'), 'utf-8')).toContain('generatedAt');
    await expect(readFile(join(tmpDir, 'openspec/specs/overview/spec.md'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
