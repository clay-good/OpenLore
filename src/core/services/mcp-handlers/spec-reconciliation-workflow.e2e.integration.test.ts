import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dispatchTool } from '../tool-dispatch.js';
import { mappingSourceFingerprint } from '../../generator/mapping-generator.js';
import type { DependencyGraphResult } from '../../analyzer/dependency-graph.js';

const repos: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map(repo => rm(repo, { recursive: true, force: true })));
});

async function createWorkflowFixture(): Promise<{ root: string; mappingPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-spec-workflow-'));
  repos.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'OpenLore Test']);
  git(root, ['config', 'user.email', 'test@openlore.local']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  await write(root, 'src/billing.ts', 'export function collectPayment(amount: number): void {}\nexport function refundPayment(): void {}\n');
  await write(
    root,
    'openspec/specs/billing/spec.md',
    '# Billing\n\n> Source files: src/billing.ts\n\n## Requirements\n\n' +
      '### Requirement: Collect payment\n\n- **Implementation**: `collectPayment::src/billing.ts`\n\n' +
      '### Requirement: Legacy charge\n',
  );

  const depGraph = {
    nodes: [{
      id: 'src/billing.ts',
      file: { path: 'src/billing.ts', name: 'billing.ts', extension: '.ts' },
      exports: [
        { name: 'collectPayment', kind: 'function', line: 1, isType: false },
        { name: 'refundPayment', kind: 'function', line: 2, isType: false },
      ],
      metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 1 },
    }],
    edges: [], clusters: [], structuralClusters: [], cycles: [],
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    statistics: { nodeCount: 1, edgeCount: 0, importEdgeCount: 0, httpEdgeCount: 0, avgDegree: 0, density: 0, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0 },
  } as unknown as DependencyGraphResult;
  const analysis = '.openlore/analysis';
  await write(root, `${analysis}/dependency-graph.json`, JSON.stringify(depGraph));
  await write(root, `${analysis}/repo-structure.json`, JSON.stringify({
    domains: [{ name: 'billing', files: ['src/billing.ts'], entities: [], keyFile: 'src/billing.ts', suggestedSpecPath: 'openspec/specs/billing/spec.md' }],
    undomained: [], schemas: [], routeInventory: { total: 0, byMethod: {}, byFramework: {}, routes: [] },
  }));
  await write(root, `${analysis}/llm-context.json`, JSON.stringify({
    phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'deep', files: [{ path: 'src/billing.ts', content: '', tokens: 0 }], totalTokens: 0 },
    phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
    signatures: [{
      path: 'src/billing.ts', language: 'TypeScript', entries: [
        { kind: 'function', name: 'collectPayment', signature: 'function collectPayment(amount: number): void' },
        { kind: 'function', name: 'refundPayment', signature: 'function refundPayment(): void' },
      ],
    }],
    callGraph: {
      nodes: [
        { id: 'src/billing.ts::collectPayment', name: 'collectPayment', filePath: 'src/billing.ts', fanIn: 1, fanOut: 0, isExternal: false, isTest: false },
        { id: 'src/billing.ts::refundPayment', name: 'refundPayment', filePath: 'src/billing.ts', fanIn: 0, fanOut: 0, isExternal: false, isTest: false },
      ],
      edges: [], entryPoints: [], hubFunctions: [], layerViolations: [], inheritanceEdges: [], classes: [],
      stats: { totalNodes: 2, totalEdges: 0, avgFanIn: 0.5, avgFanOut: 0 },
    },
  }));
  const mappingPath = `${analysis}/mapping.json`;
  await write(root, mappingPath, JSON.stringify({
    version: 2,
    generatedAt: new Date(0).toISOString(),
    sourceAnalysisFingerprint: mappingSourceFingerprint(depGraph),
    mappings: [
      {
        requirement: 'Collect payment', service: 'BillingService', domain: 'billing',
        specFile: 'openspec/specs/billing/spec.md',
        functions: [{ name: 'collectPayment', file: 'src/billing.ts', kind: 'function', line: 1, confidence: 'exact' }],
      },
      {
        requirement: 'Legacy charge', service: 'BillingService', domain: 'billing',
        specFile: 'openspec/specs/billing/spec.md', functions: [],
      },
    ],
    orphanFunctions: [],
    stats: { totalRequirements: 1, mappedRequirements: 1, totalExportedFunctions: 2, orphanCount: 0 },
  }));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'baseline', '--no-gpg-sign']);
  return { root, mappingPath: join(root, mappingPath) };
}

describe('agent-neutral MCP spec reconciliation workflow', () => {
  it('distinguishes covered, structural-change, cache fallback, and unavailable observations', async () => {
    const { root, mappingPath } = await createWorkflowFixture();
    const call = (name: string, args: Record<string, unknown> = {}) =>
      dispatchTool(name, { directory: root, ...args }, root);

    const architecture = await call('get_architecture_overview') as { domainEvidence: Array<{ name: string }> };
    const spec = await call('get_spec', { domain: 'billing' }) as { content: string };
    const mapping = await call('get_mapping', { domain: 'billing' }) as { mappings: Array<{ functions: Array<{ name: string }> }> };
    const coverage = await call('audit_spec_coverage') as {
      mappingCoverage: { state: string };
      uncoveredFunctions: Array<{ name: string }>;
      orphanRequirements: Array<{ requirement: string }>;
    };

    expect(architecture.domainEvidence.map(domain => domain.name)).toContain('billing');
    expect(spec.content).toContain('Collect payment');
    expect(mapping.mappings[0].functions[0].name).toBe('collectPayment'); // covered / consistent evidence
    expect(coverage.mappingCoverage.state).toBe('available');
    expect(coverage.uncoveredFunctions.map(fn => fn.name)).toEqual(['refundPayment']);
    expect(coverage.orphanRequirements.map(item => item.requirement)).toContain('Legacy charge');

    await write(root, 'src/billing.ts', 'export function collectPayment(amount: number, currency: string): void {}\nexport function refundPayment(): void {}\n');
    const structural = await call('structural_diff', { baseRef: 'HEAD' }) as { signatureChanged: Array<{ name: string }> };
    expect(structural.signatureChanged.map(change => change.name)).toContain('collectPayment');

    await writeFile(mappingPath, JSON.stringify({
      version: 2, sourceAnalysisFingerprint: 'outdated', mappings: [], orphanFunctions: [], stats: {},
    }));
    const stale = await call('audit_spec_coverage') as { mappingCoverage: { state: string; source: string; cacheReason: string } };
    expect(stale.mappingCoverage).toMatchObject({
      state: 'available', source: 'derived', cacheReason: 'incompatible-provenance',
    });

    await rm(mappingPath);
    const missingCache = await call('audit_spec_coverage') as { mappingCoverage: { state: string; source: string; cacheReason: string } };
    expect(missingCache.mappingCoverage).toMatchObject({
      state: 'available', source: 'derived', cacheReason: 'mapping-not-generated',
    });

    await rm(join(root, 'openspec/specs/billing/spec.md'));
    const unavailable = await call('audit_spec_coverage') as { mappingCoverage: { state: string; reason: string } };
    expect(unavailable.mappingCoverage).toMatchObject({ state: 'unavailable', reason: 'specs-unavailable' });
  });
});
