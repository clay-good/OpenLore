import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreAudit } from './audit.js';
import { mappingSourceFingerprint } from '../core/generator/mapping-generator.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(mapping?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-audit-'));
  roots.push(root);
  const analysis = join(root, '.openlore', 'analysis');
  await mkdir(analysis, { recursive: true });
  await writeFile(join(analysis, 'llm-context.json'), JSON.stringify({
    callGraph: {
      nodes: [{ id: 'src/a.ts::work', name: 'work', filePath: 'src/a.ts', fanIn: 2, fanOut: 0, isExternal: false, isTest: false }],
      hubFunctions: [],
    },
  }));
  if (mapping !== undefined) await writeFile(join(analysis, 'mapping.json'), mapping);
  return root;
}

describe('openloreAudit mapping provenance', () => {
  it('reports a missing mapping without fabricating uncovered functions', async () => {
    const report = await openloreAudit({ rootPath: await fixture(), save: false });
    expect(report.mappingCoverage.state).toBe('missing');
    expect(report.mappingCoverage).toMatchObject({
      reason: 'mapping-not-generated',
      remediation: expect.stringContaining('openlore generate'),
    });
    expect(report.uncoveredFunctions).toEqual([]);
    expect(report.hubGaps).toEqual([]);
    expect(report.summary).toMatchObject({ totalFunctions: 1, coveredFunctions: 0, uncoveredCount: 0 });
  });

  it('reports invalid mapping JSON as degraded coverage', async () => {
    const report = await openloreAudit({ rootPath: await fixture('{not json'), save: false });
    expect(report.mappingCoverage.state).toBe('invalid');
    expect(report.mappingCoverage.reason).toBe('invalid-json');
    expect(report.uncoveredFunctions).toEqual([]);
  });

  it('withholds coverage claims when mapping provenance is stale', async () => {
    const report = await openloreAudit({ rootPath: await fixture(JSON.stringify({
      version: 2, sourceAnalysisFingerprint: 'outdated', mappings: [], orphanFunctions: [], stats: {},
    })), save: false });
    expect(report.mappingCoverage.state).toBe('stale');
    expect(report.mappingCoverage.reason).toBe('incompatible-provenance');
    expect(report.uncoveredFunctions).toEqual([]);
  });

  it('withholds global coverage for a domain-scoped mapping artifact', async () => {
    const report = await openloreAudit({ rootPath: await fixture(JSON.stringify({
      version: 2,
      sourceAnalysisFingerprint: 'irrelevant-for-scoped-artifact',
      scope: { domains: ['billing'] },
      mappings: [], orphanFunctions: [], stats: {},
    })), save: false });
    expect(report.mappingCoverage).toMatchObject({
      state: 'stale',
      reason: 'scoped-artifact',
      remediation: expect.stringContaining('without `--domains`'),
    });
    expect(report.uncoveredFunctions).toEqual([]);
  });

  it('applies file scope before the uncovered result limit', async () => {
    const root = await fixture();
    const analysis = join(root, '.openlore', 'analysis');
    const nodes = [
      { id: 'src/a.ts::a', name: 'a', filePath: 'src/a.ts', fanIn: 0, fanOut: 0, isExternal: false, isTest: false },
      { id: 'src/b.ts::b', name: 'b', filePath: 'src/b.ts', fanIn: 0, fanOut: 0, isExternal: false, isTest: false },
      { id: 'src/billing/pay.ts::pay', name: 'pay', filePath: 'src/billing/pay.ts', fanIn: 0, fanOut: 0, isExternal: false, isTest: false },
    ];
    await writeFile(join(analysis, 'llm-context.json'), JSON.stringify({ callGraph: { nodes, hubFunctions: [] } }));
    const graph = {
      nodes: nodes.map(node => ({ file: { path: node.filePath }, exports: [{ name: node.name, kind: 'function', line: 1, isType: false }] })),
      edges: [], clusters: [], structuralClusters: [], rankings: {}, cycles: [], statistics: {},
    };
    await writeFile(join(analysis, 'dependency-graph.json'), JSON.stringify(graph));
    await writeFile(join(analysis, 'mapping.json'), JSON.stringify({
      version: 2, generatedAt: new Date().toISOString(), sourceAnalysisFingerprint: mappingSourceFingerprint(graph as never),
      mappings: [], orphanFunctions: [], stats: {},
    }));
    const report = await openloreAudit({ rootPath: root, save: false, files: ['src/billing/pay.ts'], domains: ['billing'], maxUncovered: 1 });
    expect(report.uncoveredFunctions).toEqual([expect.objectContaining({ name: 'pay', file: 'src/billing/pay.ts' })]);
    expect(report.summary).toMatchObject({ totalFunctions: 1, uncoveredCount: 1 });
  });
});
