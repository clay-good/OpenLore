import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreAudit } from './audit.js';
import { SPEC_LINK_INDEX_VERSION } from '../core/generator/spec-link-index.js';
import type { AuditReport } from '../types/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type NodeFixture = { name: string; filePath: string; fanIn?: number };

function v2NumericSummaryContract(report: AuditReport): number[] {
  return [
    report.summary.coveredFunctions,
    report.summary.coveragePct,
    report.summary.uncoveredCount,
    report.summary.hubGapCount,
    report.summary.orphanRequirementCount,
  ];
}

interface FixtureOptions {
  /** Call-graph functions the audit measures coverage over. */
  nodes?: NodeFixture[];
  /** Domain specs written to `openspec/specs/<domain>/spec.md`. */
  specs?: Record<string, string>;
  /** Raw `mapping.json` content, when the test needs a specific cache state. */
  mapping?: string;
  /** Omit the dependency graph to simulate a repository with no analysis. */
  withGraph?: boolean;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const nodes = options.nodes ?? [{ name: 'work', filePath: 'src/a.ts', fanIn: 2 }];
  const root = await mkdtemp(join(tmpdir(), 'openlore-audit-'));
  roots.push(root);
  const analysis = join(root, '.openlore', 'analysis');
  await mkdir(analysis, { recursive: true });

  await writeFile(join(analysis, 'llm-context.json'), JSON.stringify({
    callGraph: {
      nodes: nodes.map(node => ({
        id: `${node.filePath}::${node.name}`, name: node.name, filePath: node.filePath,
        fanIn: node.fanIn ?? 0, fanOut: 0, isExternal: false, isTest: false,
      })),
      hubFunctions: [],
    },
  }));

  if (options.withGraph !== false) {
    const byFile = new Map<string, NodeFixture[]>();
    for (const node of nodes) byFile.set(node.filePath, [...(byFile.get(node.filePath) ?? []), node]);
    await writeFile(join(analysis, 'dependency-graph.json'), JSON.stringify({
      nodes: [...byFile].map(([path, fns]) => ({
        file: { path },
        exports: fns.map(fn => ({ name: fn.name, kind: 'function', line: 1, isType: false })),
      })),
      edges: [], clusters: [], structuralClusters: [], rankings: {}, cycles: [], statistics: {},
    }));
  }

  for (const [domain, content] of Object.entries(options.specs ?? {})) {
    await mkdir(join(root, 'openspec', 'specs', domain), { recursive: true });
    await writeFile(join(root, 'openspec', 'specs', domain, 'spec.md'), content);
  }

  if (options.mapping !== undefined) await writeFile(join(analysis, 'mapping.json'), options.mapping);
  return root;
}

const specWith = (requirement: string, anchor?: string): string =>
  `# Spec\n\n### Requirement: ${requirement}\n\nThe system SHALL work.\n${anchor ? `- **Implementation**: \`${anchor}\`\n` : ''}`;

describe('openloreAudit — coverage availability', () => {
  it('preserves numeric v2 summary fields while reporting unavailable coverage explicitly', async () => {
    const report = await openloreAudit({
      rootPath: await fixture({ withGraph: false, specs: { core: specWith('Works', 'work::src/a.ts') } }),
      save: false,
    });
    expect(report.mappingCoverage).toMatchObject({
      state: 'unavailable',
      reason: 'analysis-unavailable',
      remediation: expect.stringContaining('openlore analyze'),
    });
    expect(report.summary).toMatchObject({
      totalFunctions: 1, coveredFunctions: 0, coveragePct: 0,
      uncoveredCount: 0, hubGapCount: 0, orphanRequirementCount: 0,
    });
    expect(v2NumericSummaryContract(report)).toEqual([0, 0, 0, 0, 0]);
    expect(report.uncoveredFunctions).toEqual([]);
    expect(report.hubGaps).toEqual([]);
  });

  it('does not let one anchor cover a same-named function in another file', async () => {
    // Coverage keys used to include the bare symbol name, so `work::src/a.ts`
    // marked an unrelated `work` in `src/b.ts` covered too — the audit reported
    // evidence it did not have.
    const report = await openloreAudit({
      rootPath: await fixture({
        nodes: [{ name: 'work', filePath: 'src/a.ts' }, { name: 'work', filePath: 'src/b.ts' }],
        specs: { core: specWith('Works', 'work::src/a.ts') },
      }),
      save: false,
    });
    expect(report.summary).toMatchObject({ totalFunctions: 2, coveredFunctions: 1, uncoveredCount: 1 });
    expect(report.uncoveredFunctions.map(fn => `${fn.name}::${fn.file}`)).toEqual(['work::src/b.ts']);
  });

  it('reports unavailable when no specifications exist to derive links from', async () => {
    const report = await openloreAudit({ rootPath: await fixture(), save: false });
    expect(report.mappingCoverage).toMatchObject({ state: 'unavailable', reason: 'specs-unavailable' });
    expect(report.summary.coveragePct).toBe(0);
  });

  it('derives coverage in memory when mapping.json has never been generated', async () => {
    const report = await openloreAudit({
      rootPath: await fixture({ specs: { core: specWith('Works', 'work::src/a.ts') } }),
      save: false,
    });
    expect(report.mappingCoverage).toMatchObject({
      state: 'available', source: 'derived', cacheReason: 'mapping-not-generated',
    });
    expect(report.summary).toMatchObject({ totalFunctions: 1, coveredFunctions: 1, coveragePct: 100, uncoveredCount: 0 });
  });

  it('derives coverage in memory rather than trusting a legacy probabilistic artifact', async () => {
    const report = await openloreAudit({
      rootPath: await fixture({
        specs: { core: specWith('Works', 'work::src/a.ts') },
        mapping: JSON.stringify({ version: 2, sourceAnalysisFingerprint: 'outdated', mappings: [], orphanFunctions: [], stats: {} }),
      }),
      save: false,
    });
    expect(report.mappingCoverage).toMatchObject({
      state: 'available', source: 'derived', cacheReason: 'incompatible-provenance',
    });
    expect(report.summary.coveredFunctions).toBe(1);
  });

  it('derives coverage in memory when mapping.json is not valid JSON', async () => {
    const report = await openloreAudit({
      rootPath: await fixture({ specs: { core: specWith('Works', 'work::src/a.ts') }, mapping: '{not json' }),
      save: false,
    });
    expect(report.mappingCoverage).toMatchObject({
      state: 'available', source: 'derived', cacheReason: 'invalid-json',
    });
  });

  it('serves a persisted index from cache once it matches the current inputs', async () => {
    const root = await fixture({ specs: { core: specWith('Works', 'work::src/a.ts') } });
    await openloreAudit({ rootPath: root, save: true });
    const second = await openloreAudit({ rootPath: root, save: false });
    expect(second.mappingCoverage).toMatchObject({ state: 'available', source: 'cache' });
    expect(second.mappingCoverage.cacheReason).toBeUndefined();
  });

  it('invalidates the cache when a spec is edited, without losing availability', async () => {
    const root = await fixture({ specs: { core: specWith('Works', 'work::src/a.ts') } });
    await openloreAudit({ rootPath: root, save: true });
    await writeFile(
      join(root, 'openspec', 'specs', 'core', 'spec.md'),
      specWith('Works', 'work::src/a.ts') + specWith('Also Works'),
    );
    const after = await openloreAudit({ rootPath: root, save: false });
    expect(after.mappingCoverage).toMatchObject({
      state: 'available', source: 'derived', cacheReason: 'fingerprint-mismatch',
    });
    expect(after.orphanRequirements).toEqual([
      expect.objectContaining({ requirement: 'Also Works', domain: 'core' }),
    ]);
  });
});

describe('openloreAudit — observed values are never unknown values', () => {
  it('reports an observed zero as numeric zero with available state', async () => {
    const report = await openloreAudit({
      rootPath: await fixture({
        nodes: [{ name: 'work', filePath: 'src/a.ts' }],
        specs: { core: specWith('No Anchor Here') },
      }),
      save: false,
    });
    expect(report.mappingCoverage.state).toBe('available');
    expect(report.summary).toMatchObject({ totalFunctions: 1, coveredFunctions: 0, coveragePct: 0, uncoveredCount: 1 });
    expect(report.uncoveredFunctions).toEqual([expect.objectContaining({ name: 'work' })]);
  });

  it('counts a file-only anchor as footprint evidence, never as function coverage', async () => {
    const report = await openloreAudit({
      rootPath: await fixture({ specs: { core: specWith('File Only', 'src/a.ts') } }),
      save: false,
    });
    expect(report.summary).toMatchObject({ coveredFunctions: 0, uncoveredCount: 1 });
    expect(report.orphanRequirements).toEqual([expect.objectContaining({ requirement: 'File Only' })]);
  });
});

describe('openloreAudit — scoping and persistence', () => {
  it('applies file scope before the uncovered result limit', async () => {
    const root = await fixture({
      nodes: [
        { name: 'a', filePath: 'src/a.ts' },
        { name: 'b', filePath: 'src/b.ts' },
        { name: 'pay', filePath: 'src/billing/pay.ts' },
      ],
      specs: { billing: specWith('Charges A Card') },
    });
    const report = await openloreAudit({
      rootPath: root, save: false, files: ['src/billing/pay.ts'], domains: ['billing'], maxUncovered: 1,
    });
    expect(report.uncoveredFunctions).toEqual([expect.objectContaining({ name: 'pay', file: 'src/billing/pay.ts' })]);
    expect(report.summary).toMatchObject({ totalFunctions: 1, uncoveredCount: 1 });
  });

  it('does not persist a domain-scoped derivation over the global cache', async () => {
    const root = await fixture({
      specs: { core: specWith('Works', 'work::src/a.ts'), billing: specWith('Charges') },
    });
    await openloreAudit({ rootPath: root, save: true, domains: ['billing'] });
    await expect(readFile(join(root, '.openlore', 'analysis', 'mapping.json'), 'utf-8')).rejects.toThrow();
  });

  it('persists a global derivation so the next audit can read it from cache', async () => {
    const root = await fixture({ specs: { core: specWith('Works', 'work::src/a.ts') } });
    await openloreAudit({ rootPath: root, save: true });
    const persisted = JSON.parse(await readFile(join(root, '.openlore', 'analysis', 'mapping.json'), 'utf-8'));
    expect(persisted).toMatchObject({ version: SPEC_LINK_INDEX_VERSION, stats: { linked: 1 } });
  });
});
