import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderRefresh } from './mapping.js';
import { mappingViewOf, resolveSpecLinkIndex } from '../../core/generator/spec-link-service.js';
import { SPEC_LINK_INDEX_VERSION } from '../../core/generator/spec-link-index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(specs: Record<string, string>, exports: Record<string, string[]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-mapping-'));
  roots.push(root);
  const analysis = join(root, '.openlore', 'analysis');
  await mkdir(analysis, { recursive: true });
  await writeFile(join(analysis, 'dependency-graph.json'), JSON.stringify({
    nodes: Object.entries(exports).map(([path, names]) => ({
      file: { path },
      exports: names.map((name, index) => ({ name, kind: 'function', line: index + 1, isType: false })),
    })),
    edges: [], clusters: [], structuralClusters: [], rankings: {}, cycles: [], statistics: {},
  }));
  for (const [domain, content] of Object.entries(specs)) {
    await mkdir(join(root, 'openspec', 'specs', domain), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', domain, 'spec.md'), content);
  }
  return root;
}

const requirement = (name: string, anchor?: string): string =>
  `### Requirement: ${name}\n\nThe system SHALL work.\n${anchor ? `- **Implementation**: \`${anchor}\`\n` : ''}\n`;

describe('mapping refresh — persistence and idempotence', () => {
  it('serves the deterministic v2 shape without legacy probabilistic fields', async () => {
    const root = await fixture(
      { auth: `# Auth\n\n${requirement('Sessions Expire', 'createSession::src/auth.ts')}` },
      { 'src/auth.ts': ['createSession'] },
    );
    const resolution = await resolveSpecLinkIndex({ rootPath: root, persist: false });
    const view = mappingViewOf(resolution) as {
      schemaVersion?: number;
      mappings?: Array<Record<string, unknown>>;
    };

    expect(view.schemaVersion).toBe(2);
    expect(view.mappings?.[0]).toMatchObject({
      requirement: 'Sessions Expire',
      state: 'linked',
      functions: [{ name: 'createSession', file: 'src/auth.ts' }],
    });
    expect(view.mappings?.[0]).not.toHaveProperty('service');
    expect(view.mappings?.[0]).not.toHaveProperty('confidence');
    expect(view.mappings?.[0]?.functions).toEqual([
      expect.not.objectContaining({ confidence: expect.anything() }),
    ]);
  });

  it('writes a versioned provenance-bound index without an LLM', async () => {
    const root = await fixture(
      { auth: `# Auth\n\n${requirement('Sessions Expire', 'createSession::src/auth.ts')}` },
      { 'src/auth.ts': ['createSession'] },
    );
    const first = await resolveSpecLinkIndex({ rootPath: root, persist: true });
    expect(first.state).toBe('available');

    const written = JSON.parse(await readFile(join(root, '.openlore', 'analysis', 'mapping.json'), 'utf-8'));
    expect(written).toMatchObject({ version: SPEC_LINK_INDEX_VERSION, stats: { linked: 1, totalRequirements: 1 } });
    expect(written.provenance).toMatchObject({
      analysisGeneration: expect.any(String),
      specDigest: expect.any(String),
    });
  });

  it('is idempotent: a second refresh reads the cache and produces the same links', async () => {
    const root = await fixture(
      { auth: `# Auth\n\n${requirement('Sessions Expire', 'createSession::src/auth.ts')}` },
      { 'src/auth.ts': ['createSession'] },
    );
    const first = await resolveSpecLinkIndex({ rootPath: root, persist: true });
    const second = await resolveSpecLinkIndex({ rootPath: root, persist: true });

    expect(first.state === 'available' && first.source).toBe('derived');
    expect(second.state === 'available' && second.source).toBe('cache');
    expect(second.state === 'available' && first.state === 'available'
      && second.index.links).toEqual(first.state === 'available' ? first.index.links : null);
  });

  it('rebuilds after a spec edit rather than serving the stale cache', async () => {
    const root = await fixture(
      { auth: `# Auth\n\n${requirement('Sessions Expire', 'createSession::src/auth.ts')}` },
      { 'src/auth.ts': ['createSession', 'destroySession'] },
    );
    await resolveSpecLinkIndex({ rootPath: root, persist: true });
    await writeFile(
      join(root, 'openspec', 'specs', 'auth', 'spec.md'),
      `# Auth\n\n${requirement('Sessions Expire', 'createSession::src/auth.ts')}${requirement('Sessions End', 'destroySession::src/auth.ts')}`,
    );

    const after = await resolveSpecLinkIndex({ rootPath: root, persist: true });
    expect(after.state === 'available' && after.source).toBe('derived');
    expect(after.state === 'available' && after.index.stats.linked).toBe(2);
  });
});

describe('renderRefresh', () => {
  it('summarizes every link state and names the artifact', async () => {
    const root = await fixture(
      { auth: `# Auth\n\n${requirement('Linked', 'createSession::src/auth.ts')}${requirement('Bare')}` },
      { 'src/auth.ts': ['createSession'] },
    );
    const resolution = await resolveSpecLinkIndex({ rootPath: root, persist: false });
    if (resolution.state !== 'available') throw new Error('fixture should resolve');

    const output = renderRefresh(resolution.index, resolution.artifactPath, resolution.source);
    expect(output).toContain('requirements:  2');
    expect(output).toContain('linked:        1');
    expect(output).toContain('unmapped:      1');
    expect(output).toContain('mapping.json');
  });

  it('lists ambiguous anchors with their candidates and selects none', async () => {
    const root = await fixture(
      { auth: `# Auth\n\n${requirement('Ambiguous', 'createSession')}` },
      { 'src/auth.ts': ['createSession'], 'src/legacy.ts': ['createSession'] },
    );
    const resolution = await resolveSpecLinkIndex({ rootPath: root, persist: false });
    if (resolution.state !== 'available') throw new Error('fixture should resolve');

    const output = renderRefresh(resolution.index, resolution.artifactPath, resolution.source);
    expect(output).toContain('ambiguous:     1');
    expect(output).toContain('Ambiguous anchors (no candidate was selected)');
    expect(output).toContain('src/auth.ts:1');
    expect(output).toContain('src/legacy.ts:1');
  });

  it('gives legacy specs an actionable per-requirement anchor migration', async () => {
    const root = await fixture(
      { auth: '# Auth\n\n> Source files: `src/auth.ts`\n\n' + requirement('Legacy Requirement') },
      { 'src/auth.ts': ['createSession'] },
    );
    const resolution = await resolveSpecLinkIndex({ rootPath: root, persist: false });
    if (resolution.state !== 'available') throw new Error('fixture should resolve');

    const output = renderRefresh(resolution.index, resolution.artifactPath, resolution.source, 'incompatible-provenance');
    expect(output).toContain('Legacy mapping cache was incompatible');
    expect(output).toContain('[auth] Legacy Requirement');
    expect(output).toContain('Legacy `> Source files:` headers provide domain footprint only');
    expect(output).toContain('symbol::path/to/file.ts');
  });

  it('lists stale anchors without silently choosing a replacement', async () => {
    const root = await fixture(
      { auth: `# Auth\n\n${requirement('Removed Handler', 'oldHandler::src/auth.ts')}` },
      { 'src/auth.ts': ['newHandler'] },
    );
    const resolution = await resolveSpecLinkIndex({ rootPath: root, persist: false });
    if (resolution.state !== 'available') throw new Error('fixture should resolve');

    const output = renderRefresh(resolution.index, resolution.artifactPath, resolution.source);
    expect(output).toContain('Stale implementation anchors:');
    expect(output).toContain('oldHandler::src/auth.ts');
    expect(output).toContain('No candidate is selected automatically');
  });
});
