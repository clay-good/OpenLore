/**
 * Analysis Artifact Generator Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateArtifacts,
  generateAndSaveArtifacts,
} from './artifact-generator.js';
import type { RepositoryMap, DetectedFramework, LanguageBreakdown, DirectoryStats } from './repository-mapper.js';
import type { DependencyGraphResult, DependencyNode, DependencyEdge, FileCluster } from './dependency-graph.js';
import type { ScoredFile, ProjectType } from '../../types/index.js';
import { MAX_HTML_INLINE_SCRIPT_CHARS } from '../../constants.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `artifact-gen-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function createScoredFile(overrides: Partial<ScoredFile> & { name: string; path: string }): ScoredFile {
  return {
    path: overrides.path,
    absolutePath: overrides.absolutePath ?? `/test/${overrides.path}`,
    name: overrides.name,
    extension: overrides.extension ?? '.ts',
    size: overrides.size ?? 100,
    lines: overrides.lines ?? 10,
    depth: overrides.depth ?? 0,
    directory: overrides.directory ?? '',
    isEntryPoint: overrides.isEntryPoint ?? false,
    isConfig: overrides.isConfig ?? false,
    isTest: overrides.isTest ?? false,
    isGenerated: overrides.isGenerated ?? false,
    score: overrides.score ?? 50,
    scoreBreakdown: overrides.scoreBreakdown ?? { name: 10, path: 10, structure: 10, connectivity: 20 },
    tags: overrides.tags ?? [],
  };
}

function createMockRepoMap(overrides: Partial<RepositoryMap> = {}): RepositoryMap {
  const defaultFiles: ScoredFile[] = [
    createScoredFile({ name: 'index.ts', path: 'src/index.ts', directory: 'src', isEntryPoint: true, score: 80, tags: ['entry-point'] }),
    createScoredFile({ name: 'user.ts', path: 'src/models/user.ts', directory: 'src/models', score: 75, tags: ['schema'] }),
    createScoredFile({ name: 'user-service.ts', path: 'src/services/user-service.ts', directory: 'src/services', score: 70 }),
    createScoredFile({ name: 'user-controller.ts', path: 'src/controllers/user-controller.ts', directory: 'src/controllers', score: 65 }),
    createScoredFile({ name: 'user-repository.ts', path: 'src/repositories/user-repository.ts', directory: 'src/repositories', score: 60 }),
    createScoredFile({ name: 'config.ts', path: 'src/config/config.ts', directory: 'src/config', isConfig: true, score: 55 }),
    createScoredFile({ name: 'auth.ts', path: 'src/middleware/auth.ts', directory: 'src/middleware', score: 50 }),
  ];

  const defaultFrameworks: DetectedFramework[] = [
    { name: 'Express', category: 'backend', confidence: 'high', evidence: ['package.json'] },
    { name: 'Jest', category: 'testing', confidence: 'high', evidence: ['jest.config.js'] },
  ];

  const defaultLanguages: LanguageBreakdown[] = [
    { language: 'TypeScript', extension: '.ts', fileCount: 50, percentage: 80 },
    { language: 'JavaScript', extension: '.js', fileCount: 10, percentage: 16 },
    { language: 'JSON', extension: '.json', fileCount: 3, percentage: 4 },
  ];

  const defaultDirs: DirectoryStats[] = [
    { path: 'src/models', fileCount: 5, purpose: 'Data models', avgScore: 70 },
    { path: 'src/services', fileCount: 8, purpose: 'Business logic', avgScore: 65 },
    { path: 'src/controllers', fileCount: 6, purpose: 'Request handlers', avgScore: 60 },
  ];

  return {
    metadata: {
      projectName: overrides.metadata?.projectName ?? 'test-project',
      projectType: overrides.metadata?.projectType ?? 'nodejs',
      rootPath: overrides.metadata?.rootPath ?? '/test',
      analyzedAt: overrides.metadata?.analyzedAt ?? '2024-01-15T10:00:00Z',
      version: overrides.metadata?.version ?? '1.0.0',
    },
    summary: {
      totalFiles: overrides.summary?.totalFiles ?? 100,
      analyzedFiles: overrides.summary?.analyzedFiles ?? 70,
      skippedFiles: overrides.summary?.skippedFiles ?? 30,
      languages: overrides.summary?.languages ?? defaultLanguages,
      frameworks: overrides.summary?.frameworks ?? defaultFrameworks,
      directories: overrides.summary?.directories ?? defaultDirs,
    },
    highValueFiles: overrides.highValueFiles ?? defaultFiles,
    entryPoints: overrides.entryPoints ?? [defaultFiles[0]],
    schemaFiles: overrides.schemaFiles ?? [defaultFiles[1]],
    configFiles: overrides.configFiles ?? [defaultFiles[5]],
    clusters: overrides.clusters ?? {
      byDirectory: {
        'src/models': [defaultFiles[1]],
        'src/services': [defaultFiles[2]],
      },
      byDomain: {
        'user': [defaultFiles[1], defaultFiles[2], defaultFiles[3]],
      },
      byLayer: {
        presentation: [defaultFiles[3]],
        business: [defaultFiles[2]],
        data: [defaultFiles[1], defaultFiles[4]],
        infrastructure: [defaultFiles[5], defaultFiles[6]],
      },
    },
    allFiles: overrides.allFiles ?? defaultFiles,
  };
}

function createMockDepGraph(overrides: Partial<DependencyGraphResult> = {}): DependencyGraphResult {
  const nodes: DependencyNode[] = overrides.nodes ?? [
    {
      id: '/test/src/index.ts',
      file: createScoredFile({ name: 'index.ts', path: 'src/index.ts' }),
      exports: [],
      metrics: { inDegree: 0, outDegree: 3, betweenness: 0.2, pageRank: 0.3 },
    },
    {
      id: '/test/src/services/user-service.ts',
      file: createScoredFile({ name: 'user-service.ts', path: 'src/services/user-service.ts' }),
      exports: [],
      metrics: { inDegree: 2, outDegree: 1, betweenness: 0.5, pageRank: 0.6 },
    },
    {
      id: '/test/src/models/user.ts',
      file: createScoredFile({ name: 'user.ts', path: 'src/models/user.ts' }),
      exports: [],
      metrics: { inDegree: 3, outDegree: 0, betweenness: 0.1, pageRank: 0.8 },
    },
  ];

  const edges: DependencyEdge[] = overrides.edges ?? [
    { source: '/test/src/index.ts', target: '/test/src/services/user-service.ts', importedNames: ['UserService'], isTypeOnly: false, weight: 1 },
    { source: '/test/src/services/user-service.ts', target: '/test/src/models/user.ts', importedNames: ['User'], isTypeOnly: false, weight: 1 },
  ];

  const clusters: FileCluster[] = overrides.clusters ?? [
    {
      id: 'cluster-0',
      name: 'services',
      files: ['/test/src/services/user-service.ts'],
      internalEdges: 0,
      externalEdges: 2,
      cohesion: 0,
      coupling: 1,
      suggestedDomain: 'services',
      color: '#7c6af7',
      isStructural: false,
    },
  ];

  return {
    nodes,
    edges,
    clusters,
    structuralClusters: overrides.structuralClusters ?? [],
    rankings: overrides.rankings ?? {
      byImportance: ['/test/src/models/user.ts', '/test/src/services/user-service.ts', '/test/src/index.ts'],
      byConnectivity: ['/test/src/services/user-service.ts', '/test/src/models/user.ts', '/test/src/index.ts'],
      clusterCenters: ['/test/src/services/user-service.ts'],
      leafNodes: ['/test/src/index.ts'],
      bridgeNodes: ['/test/src/services/user-service.ts'],
      orphanNodes: [],
    },
    cycles: overrides.cycles ?? [],
    statistics: overrides.statistics ?? {
      nodeCount: 3,
      edgeCount: 2,
      importEdgeCount: 2,
      httpEdgeCount: 0,
      avgDegree: 2,
      density: 0.33,
      clusterCount: 1,
      structuralClusterCount: 0,
      cycleCount: 0,
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('AnalysisArtifactGenerator', () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    outputDir = join(tempDir, '.openlore', 'analysis');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Phase-3 sampling determinism (fix-artifact-output-determinism)', () => {
    it('selects the same validation files in the same order across identical runs', async () => {
      // Build a real tree of 8 leaf files. The phase-3 sample shuffles the leaf
      // candidates; a seeded shuffle (hash of the sorted candidate paths) must pick
      // the SAME subset in the SAME order every run — an unseeded Math.random shuffle
      // of 8 candidates would agree across two runs with probability ~1/8!.
      const leafNodes: DependencyNode[] = [];
      const leafIds: string[] = [];
      for (let i = 0; i < 8; i++) {
        const rel = `src/leaf${i}.ts`;
        const abs = join(tempDir, rel);
        await mkdir(join(tempDir, 'src'), { recursive: true });
        await writeFile(abs, `export const leaf${i} = ${i};\n`);
        const id = `/leaf/${rel}`;
        leafIds.push(id);
        leafNodes.push({
          id,
          file: createScoredFile({ name: `leaf${i}.ts`, path: rel, absolutePath: abs }),
          exports: [],
          metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0.1 },
        });
      }
      // Empty highValueFiles ⇒ phase-2 is empty ⇒ all 8 leaves are phase-3 candidates.
      const repoMap = createMockRepoMap({ highValueFiles: [] });
      const depGraph = createMockDepGraph({
        nodes: leafNodes,
        edges: [],
        rankings: {
          byImportance: [], byConnectivity: [], clusterCenters: [],
          leafNodes: leafIds, bridgeNodes: [], orphanNodes: [],
        },
      });

      const opts = { rootDir: tempDir, outputDir, maxDeepAnalysisFiles: 0, maxValidationFiles: 8 };
      const a = await generateArtifacts(repoMap, depGraph, opts);
      const b = await generateArtifacts(repoMap, depGraph, opts);

      const pathsA = a.llmContext.phase3_validation.files.map(f => f.path);
      const pathsB = b.llmContext.phase3_validation.files.map(f => f.path);
      expect(pathsA.length).toBe(8);
      expect(pathsA).toEqual(pathsB);
    });
  });

  describe('size-cap exclusion (fix-analyze-native-abort-and-file-cost-budget)', () => {
    it('records an oversized HTML file as size-cap instead of dropping it silently', async () => {
      // HTML over MAX_HTML_INLINE_SCRIPT_CHARS never reaches the graph — the bound on the
      // same-length char-array allocation in extractHtmlScripts. It used to vanish with no trace,
      // so any inline <script> it contained read as genuinely absent.
      await mkdir(join(tempDir, 'src'), { recursive: true });
      const rel = 'src/huge.html';
      const huge = `<html><body><script>function inlineFn(){ return 1; }</script>${'<p>x</p>'.repeat(200_000)}</body></html>`;
      expect(huge.length).toBeGreaterThan(MAX_HTML_INLINE_SCRIPT_CHARS);
      await writeFile(join(tempDir, rel), huge);

      const repoMap = createMockRepoMap({
        allFiles: [createScoredFile({ name: 'huge.html', path: rel, absolutePath: join(tempDir, rel) })],
        highValueFiles: [],
      });
      const artifacts = await generateArtifacts(repoMap, createMockDepGraph({}), {
        rootDir: tempDir, outputDir, maxDeepAnalysisFiles: 0, maxValidationFiles: 0,
      });

      const rec = artifacts.parseHealth?.files.find(f => f.filePath === rel);
      expect(rec, 'the dropped file is recorded, not silent').toBeDefined();
      expect(rec!.exclusion).toBe('size-cap');
      expect(artifacts.parseHealth!.excludedByReason).toEqual({ 'size-cap': 1 });
    });

    it('leaves an ordinary HTML file alone — the cap must not catch real pages', async () => {
      await mkdir(join(tempDir, 'src'), { recursive: true });
      const rel = 'src/page.html';
      await writeFile(join(tempDir, rel), '<html><body><script>function f(){ return g(); }</script></body></html>');
      const repoMap = createMockRepoMap({
        allFiles: [createScoredFile({ name: 'page.html', path: rel, absolutePath: join(tempDir, rel) })],
        highValueFiles: [],
      });
      const artifacts = await generateArtifacts(repoMap, createMockDepGraph({}), {
        rootDir: tempDir, outputDir, maxDeepAnalysisFiles: 0, maxValidationFiles: 0,
      });
      expect(artifacts.parseHealth?.files.find(f => f.filePath === rel)).toBeUndefined();
    });
  });

  describe('RepoStructure Generation', () => {
    it('discloses a call-graph source file that belongs to no domain', async () => {
      const scriptDir = join(tempDir, 'scripts');
      const scriptPath = join(scriptDir, 'report.py');
      await mkdir(scriptDir, { recursive: true });
      await writeFile(scriptPath, 'def report():\n    return 1\n');
      const script = createScoredFile({
        name: 'report.py', path: 'scripts/report.py', absolutePath: scriptPath,
        directory: 'scripts', extension: '.py',
      });
      const repoMap = createMockRepoMap({
        allFiles: [script], highValueFiles: [script], entryPoints: [], schemaFiles: [],
        configFiles: [],
        clusters: {
          byDirectory: { scripts: [script] }, byDomain: {},
          byLayer: { presentation: [], business: [], data: [], infrastructure: [] },
        },
      });

      const artifacts = await generateArtifacts(repoMap, createMockDepGraph({ nodes: [], edges: [], clusters: [] }), {
        rootDir: tempDir, outputDir,
      });

      expect(artifacts.repoStructure.undomained).toEqual(['scripts/report.py']);
      expect(artifacts.summaryMarkdown).toContain('Undomained source files');
      expect(artifacts.summaryMarkdown).toContain('scripts/report.py');
    });

    it('should generate valid repo-structure.json', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure).toBeDefined();
      expect(artifacts.repoStructure.projectName).toBe('test-project');
      expect(artifacts.repoStructure.projectType).toBe('node-typescript');
    });

    it('should include frameworks list', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.frameworks).toContain('Express');
      expect(artifacts.repoStructure.frameworks).toContain('Jest');
    });

    it('should detect architecture pattern', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(['layered', 'modular', 'microservices', 'monolith', 'unknown']).toContain(
        artifacts.repoStructure.architecture.pattern
      );
    });

    it('should generate architecture layers', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.architecture.layers.length).toBeGreaterThan(0);

      for (const layer of artifacts.repoStructure.architecture.layers) {
        expect(layer.name).toBeDefined();
        expect(layer.purpose).toBeDefined();
        expect(Array.isArray(layer.files)).toBe(true);
      }
    });

    it('should generate domains', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.domains.length).toBeGreaterThan(0);

      for (const domain of artifacts.repoStructure.domains) {
        expect(domain.name).toBeDefined();
        expect(domain.suggestedSpecPath).toMatch(/^openspec\/specs\//);
        expect(Array.isArray(domain.files)).toBe(true);
        expect(Array.isArray(domain.entities)).toBe(true);
      }
    });

    it('does not leak source file extensions into entity names (#138)', async () => {
      const javaFiles: ScoredFile[] = [
        createScoredFile({ name: 'VetController.java', path: 'src/main/java/com/acme/vet/VetController.java', directory: 'src/main/java/com/acme/vet', score: 70 }),
        createScoredFile({ name: 'VetRepository.java', path: 'src/main/java/com/acme/vet/VetRepository.java', directory: 'src/main/java/com/acme/vet', score: 65 }),
      ];
      const repoMap = createMockRepoMap({
        highValueFiles: javaFiles,
        allFiles: javaFiles,
        clusters: {
          byDirectory: { 'src/main/java/com/acme/vet': javaFiles },
          byDomain: { vet: javaFiles },
          byLayer: { presentation: javaFiles, business: [], data: [], infrastructure: [] },
        },
      });
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      const vetDomain = artifacts.repoStructure.domains.find(d => d.name === 'vet');
      expect(vetDomain).toBeDefined();
      expect(vetDomain!.entities).toContain('VetController');
      expect(vetDomain!.entities).toContain('VetRepository');
      for (const entity of vetDomain!.entities) {
        expect(entity).not.toMatch(/Java$/);
      }
    });

    it('excludes package-info/module-info marker files from entities (#138)', async () => {
      const files: ScoredFile[] = [
        createScoredFile({ name: 'TypeToken.java', path: 'src/main/java/com/acme/reflect/TypeToken.java', directory: 'src/main/java/com/acme/reflect', score: 70 }),
        createScoredFile({ name: 'package-info.java', path: 'src/main/java/com/acme/reflect/package-info.java', directory: 'src/main/java/com/acme/reflect', score: 40 }),
        createScoredFile({ name: 'module-info.java', path: 'src/main/java/module-info.java', directory: 'src/main/java', score: 40 }),
      ];
      const repoMap = createMockRepoMap({
        highValueFiles: files,
        allFiles: files,
        clusters: {
          byDirectory: { 'src/main/java/com/acme/reflect': files },
          byDomain: { reflect: files },
          byLayer: { presentation: files, business: [], data: [], infrastructure: [] },
        },
      });

      const artifacts = await generateArtifacts(repoMap, createMockDepGraph(), {
        rootDir: tempDir,
        outputDir,
      });

      const reflect = artifacts.repoStructure.domains.find(d => d.name === 'reflect');
      expect(reflect?.entities).toContain('TypeToken');
      expect(reflect?.entities).not.toContain('PackageInfo');
      expect(reflect?.entities).not.toContain('ModuleInfo');
    });

    it('should generate entry points', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.entryPoints.length).toBeGreaterThan(0);

      for (const entry of artifacts.repoStructure.entryPoints) {
        expect(entry.file).toBeDefined();
        expect(['application-entry', 'api-entry', 'test-entry', 'build-entry']).toContain(entry.type);
        expect(Array.isArray(entry.initializes)).toBe(true);
      }
    });

    it('should generate data flow information', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.dataFlow).toBeDefined();
      expect(Array.isArray(artifacts.repoStructure.dataFlow.sources)).toBe(true);
      expect(Array.isArray(artifacts.repoStructure.dataFlow.sinks)).toBe(true);
      expect(Array.isArray(artifacts.repoStructure.dataFlow.transformers)).toBe(true);
    });

    it('should generate key files', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.keyFiles).toBeDefined();
      expect(Array.isArray(artifacts.repoStructure.keyFiles.schemas)).toBe(true);
      expect(Array.isArray(artifacts.repoStructure.keyFiles.config)).toBe(true);
      expect(Array.isArray(artifacts.repoStructure.keyFiles.auth)).toBe(true);
      expect(Array.isArray(artifacts.repoStructure.keyFiles.database)).toBe(true);
    });

    it('should include statistics', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.statistics).toBeDefined();
      expect(artifacts.repoStructure.statistics.totalFiles).toBe(100);
      expect(artifacts.repoStructure.statistics.analyzedFiles).toBe(70);
      expect(artifacts.repoStructure.statistics.nodeCount).toBe(3);
      expect(artifacts.repoStructure.statistics.edgeCount).toBe(2);
    });
  });

  describe('Summary Markdown Generation', () => {
    it('should generate valid markdown', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toBeDefined();
      expect(typeof artifacts.summaryMarkdown).toBe('string');
      expect(artifacts.summaryMarkdown.length).toBeGreaterThan(0);
    });

    it('should include project header', async () => {
      const repoMap = createMockRepoMap({ metadata: { projectName: 'my-awesome-project', projectType: 'nodejs', rootPath: '/test', analyzedAt: '2024-01-15', version: '1.0.0' } });
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('# Repository Analysis: my-awesome-project');
    });

    it('should include overview section', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('## Overview');
      expect(artifacts.summaryMarkdown).toContain('**Type**');
      expect(artifacts.summaryMarkdown).toContain('**Files Analyzed**');
    });

    it('should include architecture section', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('## Architecture Pattern');
    });

    it('should include language breakdown', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('## Language Breakdown');
      expect(artifacts.summaryMarkdown).toContain('TypeScript');
    });

    it('should include domains table', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('## Detected Domains');
      expect(artifacts.summaryMarkdown).toContain('| Domain | Files |');
    });

    it('should include dependency insights', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('## Dependency Insights');
      expect(artifacts.summaryMarkdown).toContain('**Most Connected Files:**');
    });

    it('should include cycles if present', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph({
        cycles: [['/test/a.ts', '/test/b.ts', '/test/a.ts']],
        statistics: { nodeCount: 3, edgeCount: 2, importEdgeCount: 2, httpEdgeCount: 0, avgDegree: 2, density: 0.33, clusterCount: 1, structuralClusterCount: 0, cycleCount: 1 },
      });

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('Circular Dependencies');
    });

    it('should include top files section', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('## Files Selected for Deep Analysis');
    });

    it('should include recommendations', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.summaryMarkdown).toContain('## Recommendations');
    });
  });

  describe('Dependency Diagram Generation', () => {
    it('should generate Mermaid diagram', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.dependencyDiagram).toBeDefined();
      expect(artifacts.dependencyDiagram).toContain('```mermaid');
      expect(artifacts.dependencyDiagram).toContain('graph TD');
    });

    it('should include nodes', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.dependencyDiagram).toContain('["');
    });
  });

  describe('LLM Context Generation', () => {
    it('should generate all three phases', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.llmContext).toBeDefined();
      expect(artifacts.llmContext.phase1_survey).toBeDefined();
      expect(artifacts.llmContext.phase2_deep).toBeDefined();
      expect(artifacts.llmContext.phase3_validation).toBeDefined();
    });

    it('should have correct phase purposes', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.llmContext.phase1_survey.purpose).toContain('categorization');
      expect(artifacts.llmContext.phase2_deep.purpose).toContain('extraction');
      expect(artifacts.llmContext.phase3_validation.purpose).toContain('Verification');
    });

    it('should include files in each phase', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(Array.isArray(artifacts.llmContext.phase1_survey.files)).toBe(true);
      expect(Array.isArray(artifacts.llmContext.phase2_deep.files)).toBe(true);
      expect(Array.isArray(artifacts.llmContext.phase3_validation.files)).toBe(true);
    });

    it('should estimate tokens', async () => {
      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      // FIX: renommé estimatedTokens → totalTokens (cohérent avec phase2/phase3)
      expect(artifacts.llmContext.phase1_survey.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('File Saving', () => {
    it('should save all artifacts to disk', async () => {
      const srcDir = join(tempDir, 'src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, 'index.ts'), 'export const main = () => {};');

      const repoMap = createMockRepoMap({
        highValueFiles: [
          createScoredFile({
            name: 'index.ts',
            path: 'src/index.ts',
            absolutePath: join(srcDir, 'index.ts'),
          }),
        ],
      });
      const depGraph = createMockDepGraph();

      await generateAndSaveArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      await expect(access(join(outputDir, 'repo-structure.json'))).resolves.not.toThrow();
      await expect(access(join(outputDir, 'SUMMARY.md'))).resolves.not.toThrow();
      await expect(access(join(outputDir, 'dependencies.mermaid'))).resolves.not.toThrow();
      await expect(access(join(outputDir, 'llm-context.json'))).resolves.not.toThrow();
    });

    it('should save valid JSON files', async () => {
      const srcDir = join(tempDir, 'src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, 'index.ts'), 'export const main = () => {};');

      const repoMap = createMockRepoMap({
        highValueFiles: [
          createScoredFile({
            name: 'index.ts',
            path: 'src/index.ts',
            absolutePath: join(srcDir, 'index.ts'),
          }),
        ],
      });
      const depGraph = createMockDepGraph();

      await generateAndSaveArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      const repoStructure = JSON.parse(await readFile(join(outputDir, 'repo-structure.json'), 'utf-8'));
      expect(repoStructure.projectName).toBe('test-project');

      const llmContext = JSON.parse(await readFile(join(outputDir, 'llm-context.json'), 'utf-8'));
      expect(llmContext.phase1_survey).toBeDefined();
    });

    it('writes callGraph with correct edge shape to llm-context.json', async () => {
      const srcDir = join(tempDir, 'src');
      await mkdir(srcDir, { recursive: true });
      // Two functions in one file so the call graph builder can detect the edge
      await writeFile(
        join(srcDir, 'utils.ts'),
        'export function foo() { return bar(); }\nexport function bar() { return 42; }'
      );

      const utilsFile = createScoredFile({
        name: 'utils.ts',
        path: 'src/utils.ts',
        absolutePath: join(srcDir, 'utils.ts'),
      });
      const repoMap = createMockRepoMap({
        allFiles: [utilsFile],
        highValueFiles: [utilsFile],
      });
      const depGraph = createMockDepGraph();

      await generateAndSaveArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      const llmContext = JSON.parse(await readFile(join(outputDir, 'llm-context.json'), 'utf-8'));
      expect(llmContext.callGraph).toBeDefined();
      expect(llmContext.callGraph).toHaveProperty('nodes');
      expect(llmContext.callGraph).toHaveProperty('edges');
      expect(llmContext.callGraph).toHaveProperty('stats');

      // At least one node must be present (foo and bar)
      expect(llmContext.callGraph.nodes.length).toBeGreaterThan(0);

      // Verify each edge has the required fields with correct types
      for (const edge of llmContext.callGraph.edges as Record<string, unknown>[]) {
        expect(edge).toHaveProperty('callerId');
        expect(edge).toHaveProperty('calleeId');
        expect(edge).toHaveProperty('calleeName');
        expect(edge).toHaveProperty('confidence');
        expect(typeof edge.callerId).toBe('string');
        expect(typeof edge.calleeId).toBe('string');
        expect(typeof edge.calleeName).toBe('string');
        expect(typeof edge.confidence).toBe('string');
      }
    });

    it('should create output directory if it does not exist', async () => {
      const nestedOutputDir = join(tempDir, 'nested', 'deeply', '.openlore', 'analysis');

      const repoMap = createMockRepoMap();
      const depGraph = createMockDepGraph();

      await generateAndSaveArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir: nestedOutputDir,
      });

      await expect(access(join(nestedOutputDir, 'repo-structure.json'))).resolves.not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty repo map', async () => {
      const repoMap = createMockRepoMap({
        allFiles: [],
        highValueFiles: [],
        entryPoints: [],
        schemaFiles: [],
        configFiles: [],
        summary: {
          totalFiles: 0,
          analyzedFiles: 0,
          skippedFiles: 0,
          languages: [],
          frameworks: [],
          directories: [],
        },
        clusters: {
          byDirectory: {},
          byDomain: {},
          byLayer: { presentation: [], business: [], data: [], infrastructure: [] },
        },
      });
      const depGraph = createMockDepGraph({
        nodes: [],
        edges: [],
        clusters: [],
        rankings: {
          byImportance: [],
          byConnectivity: [],
          clusterCenters: [],
          leafNodes: [],
          bridgeNodes: [],
          orphanNodes: [],
        },
        statistics: {
          nodeCount: 0,
          edgeCount: 0,
          importEdgeCount: 0,
          httpEdgeCount: 0,
          avgDegree: 0,
          density: 0,
          clusterCount: 0,
          structuralClusterCount: 0,
          cycleCount: 0,
        },
      });

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts.repoStructure.statistics.totalFiles).toBe(0);
      expect(artifacts.repoStructure.domains).toHaveLength(0);
    });

    it('should handle different project types', async () => {
      const projectTypes: ProjectType[] = ['nodejs', 'python', 'rust', 'go', 'java', 'ruby', 'php', 'unknown'];

      for (const projectType of projectTypes) {
        const repoMap = createMockRepoMap({
          metadata: { projectName: 'test', projectType, rootPath: '/test', analyzedAt: '2024-01-15', version: '1.0.0' },
        });
        const depGraph = createMockDepGraph();

        const artifacts = await generateArtifacts(repoMap, depGraph, {
          rootDir: tempDir,
          outputDir,
        });

        expect(artifacts.repoStructure.projectType).toBeDefined();
      }
    });

    it('should limit deep analysis files', async () => {
      const manyFiles = Array.from({ length: 50 }, (_, i) =>
        createScoredFile({ name: `file${i}.ts`, path: `src/file${i}.ts`, score: 50 - i })
      );

      const repoMap = createMockRepoMap({ highValueFiles: manyFiles });
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
        maxDeepAnalysisFiles: 10,
      });

      expect(artifacts.llmContext.phase2_deep.files.length).toBeLessThanOrEqual(10);
    });

    it('should handle files that cannot be read', async () => {
      const repoMap = createMockRepoMap({
        highValueFiles: [
          createScoredFile({
            name: 'missing.ts',
            path: 'src/missing.ts',
            absolutePath: '/nonexistent/path/missing.ts',
          }),
        ],
      });
      const depGraph = createMockDepGraph();

      const artifacts = await generateArtifacts(repoMap, depGraph, {
        rootDir: tempDir,
        outputDir,
      });

      expect(artifacts).toBeDefined();
    });
  });
});
