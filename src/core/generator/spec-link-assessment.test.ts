/**
 * The file assessor behind `not-assessed` spec anchors, and the cache that must honor it
 * (change: ground-generated-specs-in-the-graph). An absent symbol is evidence of removal only in a
 * file the analysis fully inventoried — and a file that exists nowhere is such evidence too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DependencyGraphResult, DependencyNode } from '../analyzer/dependency-graph.js';
import { buildFileAssessor, orphanRequirementsOf, resolveSpecLinkIndex, verifyRequirementAnchors } from './spec-link-service.js';
import { buildSpecLinkIndex } from './spec-link-index.js';
import { renderRefresh } from '../../cli/commands/mapping.js';

type Export = { name: string };
const graphOf = (nodes: Record<string, Export[]>): DependencyGraphResult => ({
  nodes: Object.entries(nodes).map(([path, exports]) => ({
    id: path,
    file: { path },
    exports: exports.map(e => ({ name: e.name, isDefault: false, isType: false, isReExport: false, kind: 'function', line: 1 })),
    metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0 },
  }) as unknown as DependencyNode),
  edges: [],
}) as unknown as DependencyGraphResult;

describe('buildFileAssessor', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-assess-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('names each boundary, and vouches only for an analyzed, extracted file', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'skipped.ts'), 'export function x() {}');
    const assess = await buildFileAssessor(root, graphOf({ 'src/ok.ts': [], 'src/job.go': [] }));
    expect(assess('src/ok.ts')).toBeUndefined();
    expect(assess('src/job.go')).toBe('language-not-extracted');
    expect(assess('src/skipped.ts')).toBe('file-not-analyzed');
  });

  it('never excuses a file that exists nowhere or is not a regular file', async () => {
    await mkdir(join(root, 'src', 'lib.ts'), { recursive: true });
    const assess = await buildFileAssessor(root, graphOf({ 'src/a.ts': [] }));
    expect(assess('src/deleted.go')).toBeUndefined();
    expect(assess('src/nope')).toBeUndefined();
    expect(assess('src/X.vue')).toBeUndefined();
    expect(assess('src/lib.ts')).toBeUndefined();
  });

  it('resolves a symlinked or differently-cased spelling to the analyzed file', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export function keep() {}');
    await symlink(join(root, 'src'), join(root, 'lnk'));
    const assess = await buildFileAssessor(root, graphOf({ 'src/a.ts': [{ name: 'keep' }] }));
    expect(assess('lnk/a.ts')).toBeUndefined();
    if (existsSync(join(root, 'SRC', 'A.ts'))) {
      // Case-insensitive volume: the other spelling is the same analyzed file.
      expect(assess('SRC/A.ts')).toBeUndefined();
    }
  });
});

describe('resolveSpecLinkIndex honors the assessment when serving its cache', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ol-assess-cache-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export function other() {}');
    await mkdir(join(root, 'openspec', 'specs', 'auth'), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', 'auth', 'spec.md'),
      '# Auth\n\n### Requirement: Login\n\nThe system SHALL log in.\n\n- **Implementation**: `gone::src/new.ts`\n\n#### Scenario: Works\n- **WHEN** x\n- **THEN** y\n');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('serves a cached accusation only while re-assessment agrees', async () => {
    const graph = graphOf({ 'src/a.ts': [{ name: 'other' }] });
    const resolve = () => resolveSpecLinkIndex({ rootPath: root, graph, persist: true });

    const fresh = await resolve();
    if (fresh.state !== 'available') throw new Error('expected an index');
    expect(fresh.source).toBe('derived');
    expect(fresh.index.links[0].state).toBe('stale');
    const cached = await resolve();
    expect(cached.state === 'available' && cached.source).toBe('cache');

    // The cited file now exists but was not analyzed: the cached `stale` would be a false accusation.
    await writeFile(join(root, 'src', 'new.ts'), 'export function gone() {}');
    const reassessed = await resolve();
    if (reassessed.state !== 'available') throw new Error('expected an index');
    expect(reassessed.source).toBe('derived');
    expect(reassessed.index.links[0].state).toBe('not-assessed');
    expect(reassessed.index.links[0].anchors[0].boundary).toBe('file-not-analyzed');
    const again = await resolve();
    expect(again.state === 'available' && again.source).toBe('cache');
  });
});

describe('not-assessed requirements are reported, not accused', () => {
  const index = () => buildSpecLinkIndex({
    specs: [{ domain: 'auth', specFile: 'openspec/specs/auth/spec.md', content:
      '# Auth\n\n### Requirement: Runs\n\nThe system SHALL run.\n\n- **Implementation**: `Run::src/job.go`\n\n'
      + '### Requirement: Dup\n\nThe system SHALL dup.\n\n- **Implementation**: `dup`, `Run::src/job.go`\n' }],
    graph: graphOf({ 'src/a.ts': [{ name: 'dup' }], 'src/b.ts': [{ name: 'dup' }] }),
    analysisGeneration: 'gen-1',
    assessFile: file => (file.endsWith('.go') ? 'language-not-extracted' : undefined),
  });

  it('ranks ambiguous above not-assessed, and never lists not-assessed as an orphan', () => {
    const built = index();
    expect(built.links.map(l => [l.requirement, l.state])).toEqual([['Dup', 'ambiguous'], ['Runs', 'not-assessed']]);
    expect(orphanRequirementsOf(built)).toEqual([]);
  });

  it('lists each not-assessed anchor with its boundary in the refresh output', () => {
    const out = renderRefresh(index(), '.openlore/analysis/mapping.json', 'derived');
    expect(out).toContain('not assessed:  1');
    expect(out).toContain('[auth] Runs → `Run::src/job.go` (language-not-extracted)');
  });
});

describe('verifyRequirementAnchors', () => {
  it('writes no anchor for two requirements that share a key but propose different symbols', () => {
    const graph = graphOf({ 'src/a.ts': [{ name: 'runAll' }, { name: 'runStep' }, { name: 'stopAll' }] });
    const verified = verifyRequirementAnchors([
      { domain: 'user', requirement: 'run', symbol: 'runAll' },
      { domain: 'user', requirement: 'Run', symbol: 'runStep' },
      { domain: 'user', requirement: 'stop', symbol: 'stopAll' },
    ], graph);
    expect([...verified.values()].map(ref => ref.name)).toEqual(['stopAll']);
  });
});
