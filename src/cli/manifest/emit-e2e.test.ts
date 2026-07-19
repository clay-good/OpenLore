/**
 * End-to-end tests for `openlore manifest emit` / `validate`. These exercise
 * the real I/O paths that the pure `buildManifest` unit tests do not:
 * reading the analysis artifacts off disk, resolving package entry points,
 * reading git state, writing the file, and the validate CLI's exit codes.
 *
 * Each test builds an isolated temp-dir fixture: a package.json, a minimal
 * `.openlore/analysis/` (llm-context.json + dependency-graph.json +
 * route-inventory.json), an openspec spec, and a real one-commit git repo.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLogger } from '../../utils/logger.js';
import { runManifestEmit } from './emit.js';
import { runManifestValidate, validateManifest } from './validate.js';
import { _resetContextCacheForTesting } from '../../core/services/mcp-handlers/utils.js';

let dir: string;

function write(rel: string, contents: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

function seedFixture(): void {
  write('package.json', JSON.stringify({ name: 'fixture-repo', version: '2.0.0', main: 'dist/api/index.js', dependencies: { stripe: '^14.0.0' } }));
  write('openspec/specs/billing/spec.md', '# Billing\n');
  write('docs/readme.md', 'docs\n');

  const nodes = [
    { id: 'src/api/handler.ts::createCharge', name: 'createCharge', filePath: 'src/api/handler.ts', language: 'TypeScript', startLine: 12, cyclomaticComplexity: 4, communityId: 'c1', isExternal: false, isTest: false },
    { id: 'src/internal/util.ts::_secret', name: '_secret', filePath: 'src/internal/util.ts', language: 'TypeScript', startLine: 3, cyclomaticComplexity: 2, communityId: 'c1', isExternal: false, isTest: false },
    { id: 'external::fetch', name: 'fetch', filePath: 'external', language: 'external', startLine: 0, isExternal: true, isTest: false },
  ];
  const callGraph = {
    nodes,
    edges: [],
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
  write('.openlore/analysis/llm-context.json', JSON.stringify({ callGraph }));
  write('.openlore/analysis/dependency-graph.json', JSON.stringify({
    nodes: [
      { id: 'a', file: { path: 'src/api/index.ts' }, exports: [{ name: 'createCharge', kind: 'unknown', line: 1, isReExport: true, reExportSource: './handler.js' }] },
      { id: 'b', file: { path: 'src/api/handler.ts' }, exports: [{ name: 'createCharge', kind: 'function', line: 12, isReExport: false }] },
    ],
  }));
  write('.openlore/analysis/route-inventory.json', JSON.stringify({
    routes: [{ method: 'post', path: '/charge', framework: 'express', file: 'src/api/handler.ts', handler: 'createCharge' }],
  }));
}

beforeAll(() => configureLogger({ quiet: true }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openlore-manifest-'));
  _resetContextCacheForTesting();
  seedFixture();
});

afterEach(() => {
  _resetContextCacheForTesting();
  rmSync(dir, { recursive: true, force: true });
});

describe('runManifestEmit (end-to-end)', () => {
  it('emits a valid manifest with git fields populated', async () => {
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('remote', 'add', 'origin', 'git@github.com:acme/fixture-repo.git');
    git('add', '-A');
    git('commit', '-m', 'init', '--no-gpg-sign');

    const out = join(dir, 'manifest.json');
    const code = await runManifestEmit({ projectRoot: dir, out });
    expect(code).toBe(0);

    const manifest = JSON.parse(readFileSync(out, 'utf-8'));
    expect(validateManifest(manifest)).toEqual([]);

    // entry-point resolution: createCharge resolved to its definition file/line.
    expect(manifest.exports.public_symbols).toContainEqual({ name: 'createCharge', kind: 'function', file: 'src/api/handler.ts', line: 12 });
    // private/non-entry symbol excluded by default.
    expect(manifest.exports.public_symbols.map((s: { name: string }) => s.name)).not.toContain('_secret');
    // git wiring + normalization.
    expect(manifest.repo.git_remote).toBe('git@github.com:acme/fixture-repo.git');
    expect(manifest.repo.git_commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(manifest.links.repo).toBe('https://github.com/acme/fixture-repo');
    expect(manifest.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // artifacts wired through.
    expect(manifest.exports.http_routes).toEqual([{ method: 'POST', path: '/charge', handler: 'src/api/handler.ts:createCharge' }]);
    expect(manifest.imports.external_packages).toEqual([{ name: 'stripe', version_range: '^14.0.0' }]);
    expect(manifest.specs.count).toBe(1);
    expect(manifest.stats).toMatchObject({ functions: 2, files: 2 });
    expect(manifest.languages).toEqual([{ name: 'typescript', files: 2, functions: 2 }]);
  });

  it('defaults output to .well-known/openlore.json and stays valid without a git repo', async () => {
    const code = await runManifestEmit({ projectRoot: dir });
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, '.well-known', 'openlore.json'), 'utf-8'));
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.repo.git_commit).toBeNull();
    expect(manifest.links.repo).toBeNull();
  });

  it('--dry-run previews the destination without writing the file (fix-cli-output-hygiene)', async () => {
    const out = join(dir, '.well-known', 'openlore.json');
    const code = await runManifestEmit({ projectRoot: dir, dryRun: true });
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('--include-private widens the surface; --max-symbols truncates', async () => {
    const wide = join(dir, 'wide.json');
    await runManifestEmit({ projectRoot: dir, out: wide, includePrivate: true });
    const wideManifest = JSON.parse(readFileSync(wide, 'utf-8'));
    expect(wideManifest.exports.public_symbols.map((s: { name: string }) => s.name)).toContain('_secret');

    const capped = join(dir, 'capped.json');
    await runManifestEmit({ projectRoot: dir, out: capped, includePrivate: true, maxSymbols: 1 });
    const cappedManifest = JSON.parse(readFileSync(capped, 'utf-8'));
    expect(cappedManifest.exports.public_symbols).toHaveLength(1);
    expect(cappedManifest.exports.truncated).toBe(true);
  });

  it('returns exit code 2 when no analysis graph exists', async () => {
    rmSync(join(dir, '.openlore'), { recursive: true, force: true });
    _resetContextCacheForTesting();
    expect(await runManifestEmit({ projectRoot: dir })).toBe(2);
  });
});

describe('runManifestValidate (end-to-end)', () => {
  it('exits 0 on a freshly emitted manifest', async () => {
    const out = join(dir, 'm.json');
    await runManifestEmit({ projectRoot: dir, out });
    expect(runManifestValidate(out)).toBe(0);
  });

  it('exits 1 on a schema-violating manifest', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ openlore_manifest_version: 2 }));
    expect(runManifestValidate(bad)).toBe(1);
  });

  it('exits 1 on invalid JSON and 2 on a missing file', () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    expect(runManifestValidate(broken)).toBe(1);
    expect(runManifestValidate(join(dir, 'does-not-exist.json'))).toBe(2);
  });
});
