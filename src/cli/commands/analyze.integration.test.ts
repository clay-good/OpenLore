/**
 * Integration tests for runAnalysis — excludePatterns end-to-end
 *
 * These tests run the real FileWalker + RepositoryMapper on a temporary
 * directory and assert that files matching excludePatterns from the config
 * are truly absent from the analysis results. Only the heavy downstream
 * stages (DependencyGraphBuilder, AnalysisArtifactGenerator) are mocked to
 * keep tests fast and free of LLM/tree-sitter dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAnalysis } from './analyze.js';

// ============================================================================
// PARTIAL MOCKS — only downstream heavy stages
// ============================================================================

vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
    success: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn(),
  },
}));

// writeFile used by runAnalysis to save dependency-graph.json
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async (path: unknown, data: unknown) => {
      // Allow writes to tmp dirs; suppress everything else
      if (typeof path === 'string' && path.includes(tmpdir())) {
        return actual.writeFile(path as Parameters<typeof actual.writeFile>[0], data as Parameters<typeof actual.writeFile>[1]);
      }
    }),
  };
});

vi.mock('../../core/analyzer/dependency-graph.js', () => ({
  DependencyGraphBuilder: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      build: vi.fn().mockResolvedValue({
        statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 },
      }),
    });
  }),
}));

vi.mock('../../core/analyzer/artifact-generator.js', () => ({
  AnalysisArtifactGenerator: vi.fn().mockImplementation(function(this: unknown) {
    const artifacts = {
      repoStructure: { architecture: { pattern: 'unknown' }, domains: [] },
      llmContext: { callGraph: null },
    };
    Object.assign(this as object, {
      generate: vi.fn().mockResolvedValue(artifacts),
      generateAndSave: vi.fn().mockResolvedValue(artifacts),
    });
  }),
}));

vi.mock('../../core/runtime/analysis-generation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/runtime/analysis-generation.js')>();
  return { ...actual, publishGeneration: vi.fn(async () => ({ generationId: 'test-generation' })) };
});

// ============================================================================
// HELPERS
// ============================================================================

const OPENLORE_CONFIG = (excludePatterns: string[], includePatterns: string[] = []) =>
  JSON.stringify({
    version: '1.0.0',
    projectType: 'python',
    openspecPath: './openspec',
    analysis: { maxFiles: 500, includePatterns, excludePatterns },
    generation: { provider: 'openai', model: 'gpt-4', domains: 'auto' },
    createdAt: new Date().toISOString(),
    lastRun: null,
  }, null, 2);

async function createFile(dir: string, relPath: string, content = ''): Promise<void> {
  const full = join(dir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

// ============================================================================
// TESTS
// ============================================================================

describe('runAnalysis integration — excludePatterns', () => {
  let tmpDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-integration-'));
    outputDir = join(tmpDir, '.openlore', 'analysis');
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('excludes files matching config excludePatterns from allFiles', async () => {
    // Config excludes static/** (where swagger lives)
    await createFile(tmpDir, '.openlore/config.json', OPENLORE_CONFIG(['static/**', '.openlore/**']));

    // Files that SHOULD be included
    await createFile(tmpDir, 'app/main.py', 'def main(): pass');
    await createFile(tmpDir, 'app/models.py', 'class User: pass');

    // Files that SHOULD be excluded
    await createFile(tmpDir, 'static/swagger/swagger-ui-bundle.js', '/* swagger */');
    await createFile(tmpDir, 'static/swagger/redoc.standalone.js', '/* redoc */');

    const { repoMap } = await runAnalysis(tmpDir, outputDir, {
      maxFiles: 500, include: [], exclude: [],
    });

    const paths = repoMap.allFiles.map(f => f.path);

    // Presence / absence
    expect(paths.some(p => p.includes('main.py'))).toBe(true);
    expect(paths.some(p => p.includes('swagger'))).toBe(false);
    expect(paths.some(p => p.includes('redoc'))).toBe(false);

    // Counts: exactly 2 files (main.py + models.py), no swagger
    expect(repoMap.allFiles).toHaveLength(2);
    expect(repoMap.summary.analyzedFiles).toBe(2);
    // totalFiles >= analyzedFiles (may include skipped entries)
    expect(repoMap.summary.totalFiles).toBeGreaterThanOrEqual(repoMap.summary.analyzedFiles);
  });

  it('caller-supplied exclude patterns also filter files', async () => {
    await createFile(tmpDir, '.openlore/config.json', OPENLORE_CONFIG([]));

    await createFile(tmpDir, 'app/main.py', 'def main(): pass');
    await createFile(tmpDir, 'legacy/old_module.py', 'pass');

    const { repoMap } = await runAnalysis(tmpDir, outputDir, {
      maxFiles: 500, include: [], exclude: ['legacy/**'],
    });

    const paths = repoMap.allFiles.map(f => f.path);

    expect(paths.some(p => p.includes('main.py'))).toBe(true);
    expect(paths.some(p => p.includes('legacy'))).toBe(false);

    // Only main.py survives
    expect(repoMap.allFiles).toHaveLength(1);
    expect(repoMap.summary.analyzedFiles).toBe(1);
  });

  it('merges config and caller patterns — both sets of files excluded', async () => {
    await createFile(tmpDir, '.openlore/config.json', OPENLORE_CONFIG(['static/**']));

    await createFile(tmpDir, 'app/main.py', 'def main(): pass');
    await createFile(tmpDir, 'static/swagger/swagger-ui-bundle.js', '/* swagger */');
    await createFile(tmpDir, 'legacy/old_module.py', 'pass');

    const { repoMap } = await runAnalysis(tmpDir, outputDir, {
      maxFiles: 500, include: [], exclude: ['legacy/**'],
    });

    const paths = repoMap.allFiles.map(f => f.path);

    expect(paths.some(p => p.includes('main.py'))).toBe(true);
    expect(paths.some(p => p.includes('swagger'))).toBe(false);
    expect(paths.some(p => p.includes('legacy'))).toBe(false);

    // Only main.py; swagger excluded by config, legacy by CLI
    expect(repoMap.allFiles).toHaveLength(1);
    expect(repoMap.summary.analyzedFiles).toBe(1);
  });

  it('includePatterns override gitignore exclusions', async () => {
    await createFile(tmpDir, '.openlore/config.json',
      OPENLORE_CONFIG([], ['*.graphql']));

    // schema.graphql gitignored — should be force-included
    await createFile(tmpDir, '.gitignore', '*.graphql');
    await createFile(tmpDir, 'app/main.py', 'def main(): pass');
    await createFile(tmpDir, 'app/schema.graphql', 'type Query { hello: String }');

    const { repoMap } = await runAnalysis(tmpDir, outputDir, {
      maxFiles: 500, include: [], exclude: [],
    });

    const paths = repoMap.allFiles.map(f => f.path);

    expect(paths.some(p => p.includes('main.py'))).toBe(true);
    expect(paths.some(p => p.includes('schema.graphql'))).toBe(true);
  });

  it('caller-supplied includePatterns also override gitignore exclusions', async () => {
    await createFile(tmpDir, '.openlore/config.json', OPENLORE_CONFIG([]));

    await createFile(tmpDir, '.gitignore', '*.proto');
    await createFile(tmpDir, 'app/main.py', 'def main(): pass');
    await createFile(tmpDir, 'app/service.proto', 'syntax = "proto3";');

    const { repoMap } = await runAnalysis(tmpDir, outputDir, {
      maxFiles: 500, include: ['*.proto'], exclude: [],
    });

    const paths = repoMap.allFiles.map(f => f.path);

    expect(paths.some(p => p.includes('service.proto'))).toBe(true);
  });

  /**
   * Metric verification — manually computed expected values
   *
   * Setup:
   *   src/api.py, src/models.py, src/utils.py  → analyzed   (3 files)
   *   static/swagger/swagger-ui-bundle.js       → excluded via excludePattern
   *   static/swagger/redoc.standalone.js        → same excluded dir
   *   .openlore/config.json                     → always skipped (SKIP_DIRECTORIES)
   *
   * Walker records 1 skip per skipped directory entry (not per file inside):
   *   static/  → 1 skip  (shouldSkipDirectory via excludePatterns)
   *   .openlore/ → 1 skip (shouldSkipDirectory via SKIP_DIRECTORIES)
   *
   * Expected metrics:
   *   allFiles.length    = 3
   *   analyzedFiles      = 3   (== allFiles.length)
   *   skippedFiles       = 2   (1 per skipped directory)
   *   totalFiles         = 5   (analyzedFiles + skippedFiles)
   */
  it('metrics match manually-computed expected values', async () => {
    await createFile(tmpDir, '.openlore/config.json', OPENLORE_CONFIG(['static/**']));
    await createFile(tmpDir, 'src/api.py',    'def get(): pass');
    await createFile(tmpDir, 'src/models.py', 'class User: pass');
    await createFile(tmpDir, 'src/utils.py',  'def helper(): pass');
    await createFile(tmpDir, 'static/swagger/swagger-ui-bundle.js', '/* swagger */');
    await createFile(tmpDir, 'static/swagger/redoc.standalone.js',  '/* redoc */');

    const { repoMap } = await runAnalysis(tmpDir, outputDir, {
      maxFiles: 500, include: [], exclude: [],
    });

    // ── allFiles content ──────────────────────────────────────────────────
    const paths = repoMap.allFiles.map(f => f.path);
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringContaining('api.py'),
      expect.stringContaining('models.py'),
      expect.stringContaining('utils.py'),
    ]));
    expect(paths.some(p => p.includes('swagger'))).toBe(false);
    expect(paths.some(p => p.includes('redoc'))).toBe(false);

    // ── exact counts ──────────────────────────────────────────────────────
    expect(repoMap.allFiles).toHaveLength(3);

    // analyzedFiles mirrors allFiles
    expect(repoMap.summary.analyzedFiles).toBe(3);

    // 1 skip per skipped directory (static/ and .openlore/)
    expect(repoMap.summary.skippedFiles).toBe(2);

    // totalFiles = analyzedFiles + skippedFiles
    expect(repoMap.summary.totalFiles).toBe(
      repoMap.summary.analyzedFiles + repoMap.summary.skippedFiles
    );
    expect(repoMap.summary.totalFiles).toBe(5);
  });
});
