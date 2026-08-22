import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreAnalyze } from './analyze.js';
import { analyzeCommand } from '../cli/commands/analyze.js';
import { TextLineIndex, _resetTextLineIndexCachesForTesting } from '../core/analyzer/text-line-index.js';
import { VectorIndex } from '../core/analyzer/vector-index.js';
import { SpecVectorIndex } from '../core/analyzer/spec-vector-index.js';
import type { AnalyzeResult } from './types.js';
import type { DependencyGraphResult } from '../core/analyzer/dependency-graph.js';

describe('CLI/API analyze parity', () => {
  const roots: string[] = [];

  afterEach(async () => {
    _resetTextLineIndexCachesForTesting();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  it('uses the same configured corpus, artifacts, inventories, indexes, and deterministic cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-analyze-parity-'));
    roots.push(root);
    await mkdir(join(root, '.openlore'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'private'), { recursive: true });
    await mkdir(join(root, 'vendor'), { recursive: true });
    await mkdir(join(root, 'openspec', 'specs', 'sample'), { recursive: true });
    const config = {
      version: '1.0.0', projectType: 'nodejs', openspecPath: './openspec',
      analysis: { maxFiles: 100, includePatterns: ['vendor/included.ts'], excludePatterns: ['private/**'] },
      generation: { provider: 'openai', model: 'gpt-4', domains: 'auto' },
      createdAt: new Date().toISOString(), lastRun: null,
    };
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify(config));
    await writeFile(join(root, 'src', 'app.ts'), [
      'import express from "express";',
      'const app = express();',
      'app.use(authMiddleware);',
      'app.get("/visible", visibleRoute);',
      'const required = process.env.REQUIRED_PARITY_TOKEN;',
      'export function visibleRoute(): string {',
      '  return "VISIBLE_PARITY_TOKEN";',
      '}',
      'function authMiddleware(): void {}',
    ].join('\n'));
    await writeFile(join(root, 'src', 'panel.tsx'), 'export function Panel({title}: {title: string}) { return <section>{title}</section>; }\n');
    await writeFile(join(root, 'src', 'schema.prisma'), 'model User {\n  id Int @id\n}\n');
    await writeFile(join(root, 'private', 'secret.ts'), 'export const secret = "EXCLUDED_SECRET_TOKEN";\n');
    await writeFile(join(root, 'vendor', 'included.ts'), 'export const vendorIncluded = "INCLUDED_VENDOR_TOKEN";\n');
    await writeFile(join(root, 'openspec', 'specs', 'sample', 'spec.md'), '# Sample\n\n## Requirements\n\n### Requirement: Visible\nThe system SHALL remain visible.\n');

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cliOutput = join(root, '.openlore', 'analysis');
    const apiOutput = join(root, '.openlore', 'api-analysis');
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    process.chdir(root);
    try {
      await analyzeCommand.parseAsync(['--no-embed', '--max-files', '100'], { from: 'user' });
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
    const readJson = async <T>(dir: string, name: string): Promise<T> => JSON.parse(await readFile(join(dir, name), 'utf8')) as T;
    const cliRepo = await readJson<AnalyzeResult['artifacts']['repoStructure']>(cliOutput, 'repo-structure.json');
    const cliContext = await readJson<AnalyzeResult['artifacts']['llmContext']>(cliOutput, 'llm-context.json');
    const cliGraph = await readJson<DependencyGraphResult>(cliOutput, 'dependency-graph.json');
    const cliFingerprint = await readJson<{ hash: string; analysisConfigHash: string }>(cliOutput, 'fingerprint.json');
    stdout.mockClear(); stderr.mockClear(); consoleLog.mockClear(); consoleError.mockClear();
    const api = await openloreAnalyze({ rootPath: root, outputPath: apiOutput, maxFiles: 100, quiet: true });
    const apiFingerprint = await readJson<{ hash: string; analysisConfigHash: string }>(apiOutput, 'fingerprint.json');

    expect(api.repoMap.allFiles.map(file => file.path)).toContain('vendor/included.ts');
    expect(api.repoMap.allFiles.some(file => file.path.includes('private/secret.ts'))).toBe(false);
    expect(cliRepo.routeInventory).toEqual(api.artifacts.repoStructure.routeInventory);
    expect(cliRepo.uiComponents).toEqual(api.artifacts.repoStructure.uiComponents);
    expect(cliRepo.schemas).toEqual(api.artifacts.repoStructure.schemas);
    expect(cliRepo.middleware).toEqual(api.artifacts.repoStructure.middleware);
    expect(cliRepo.envVars).toEqual(api.artifacts.repoStructure.envVars);
    expect(cliContext.callGraph?.nodes.map(node => [node.id, node.filePath]))
      .toEqual(api.artifacts.llmContext.callGraph?.nodes.map(node => [node.id, node.filePath]));
    expect(cliGraph).toEqual(api.depGraph);
    expect(cliFingerprint.hash).toBe(apiFingerprint.hash);
    expect(cliFingerprint.analysisConfigHash).toBe(apiFingerprint.analysisConfigHash);
    expect(VectorIndex.exists(cliOutput)).toBe(true);
    expect(VectorIndex.exists(apiOutput)).toBe(true);
    expect(SpecVectorIndex.exists(cliOutput)).toBe(true);
    expect(SpecVectorIndex.exists(apiOutput)).toBe(true);
    expect(api.indexDegradations).toBeUndefined();

    _resetTextLineIndexCachesForTesting();
    expect((await TextLineIndex.searchText(apiOutput, 'EXCLUDED_SECRET_TOKEN'))
      .some(hit => hit.filePath.includes('private/secret.ts'))).toBe(false);
    expect((await TextLineIndex.searchText(apiOutput, 'VISIBLE_PARITY_TOKEN')).length).toBeGreaterThan(0);
    expect((await TextLineIndex.searchText(cliOutput, 'VISIBLE_PARITY_TOKEN')).length).toBeGreaterThan(0);
    expect((await TextLineIndex.searchText(cliOutput, 'INCLUDED_VENDOR_TOKEN')).length).toBeGreaterThan(0);

    const cached = await openloreAnalyze({ rootPath: root, outputPath: apiOutput, maxFiles: 100, quiet: true });
    expect(cached.fromCache).toBe(true);
    expect(cached.repoMap.allFiles.map(file => file.path).sort()).toEqual(api.repoMap.allFiles.map(file => file.path).sort());
    expect(cached.repoMap.highValueFiles.length).toBeGreaterThan(0);
    expect(cached.artifacts.repoStructure).toEqual(api.artifacts.repoStructure);
    expect(cached.artifacts.llmContext.callGraph).toEqual(api.artifacts.llmContext.callGraph);
    const cachedAgain = await openloreAnalyze({ rootPath: root, outputPath: apiOutput, maxFiles: 100, quiet: true });
    expect(cachedAgain.repoMap).toEqual(cached.repoMap);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  }, 60_000);
});
