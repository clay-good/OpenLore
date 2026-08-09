import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openloreAudit } from './audit.js';

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
    expect(report.uncoveredFunctions).toEqual([]);
    expect(report.hubGaps).toEqual([]);
    expect(report.summary).toMatchObject({ totalFunctions: 1, coveredFunctions: 0, uncoveredCount: 0 });
  });

  it('reports invalid mapping JSON as degraded coverage', async () => {
    const report = await openloreAudit({ rootPath: await fixture('{not json'), save: false });
    expect(report.mappingCoverage.state).toBe('invalid');
    expect(report.uncoveredFunctions).toEqual([]);
  });

  it('withholds coverage claims when mapping provenance is stale', async () => {
    const report = await openloreAudit({ rootPath: await fixture(JSON.stringify({
      version: 2, sourceAnalysisFingerprint: 'outdated', mappings: [], orphanFunctions: [], stats: {},
    })), save: false });
    expect(report.mappingCoverage.state).toBe('stale');
    expect(report.uncoveredFunctions).toEqual([]);
  });
});
