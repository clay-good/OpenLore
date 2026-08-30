import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { ScoredFile } from '../../types/index.js';
import type { RepositoryMap } from './repository-mapper.js';
import type { DependencyGraphResult, FileCluster } from './dependency-graph.js';
import { classifyDomainFile } from './domain-naming.js';
import { reconcileRepositoryDomains } from './domain-reconciliation.js';

function file(path: string, overrides: Partial<ScoredFile> = {}): ScoredFile {
  const name = path.split('/').at(-1)!;
  const directory = path.split('/').slice(0, -1).join('/');
  const extension = name.includes('.') ? `.${name.split('.').at(-1)}` : '';
  return {
    path,
    absolutePath: `/repo/${path}`,
    name,
    extension,
    directory,
    size: 10,
    lines: 1,
    depth: path.split('/').length - 1,
    isEntryPoint: false,
    isConfig: false,
    isTest: false,
    isGenerated: false,
    score: 10,
    scoreBreakdown: { name: 1, path: 1, structure: 1, connectivity: 1 },
    tags: [],
    ...overrides,
  };
}

function repo(files: ScoredFile[], byDomain: Record<string, ScoredFile[]>): RepositoryMap {
  return {
    metadata: { projectName: 'fixture', projectType: 'nodejs', rootPath: '/repo', analyzedAt: '', version: '1' },
    summary: { totalFiles: files.length, analyzedFiles: files.length, skippedFiles: 0, languages: [], frameworks: [], directories: [] },
    highValueFiles: files,
    entryPoints: files.filter(item => item.isEntryPoint),
    schemaFiles: [],
    configFiles: [],
    clusters: { byDirectory: {}, byDomain, byLayer: { presentation: [], business: [], data: [], infrastructure: [] } },
    allFiles: files,
  };
}

function cluster(id: string, name: string, files: ScoredFile[], overrides: Partial<FileCluster> = {}): FileCluster {
  return {
    id,
    name,
    files: files.map(item => item.absolutePath),
    internalEdges: 1,
    externalEdges: 0,
    cohesion: 0.25,
    coupling: 0,
    suggestedDomain: name.split('/').at(-1)!,
    color: '#000',
    isStructural: true,
    ...overrides,
  };
}

function graph(files: ScoredFile[], clusters: FileCluster[] = [], edges: DependencyGraphResult['edges'] = []): DependencyGraphResult {
  return {
    nodes: files.map(item => ({ id: item.absolutePath, file: item, exports: [], metrics: { inDegree: 0, outDegree: 0, betweenness: 0, pageRank: 0 } })),
    edges,
    clusters,
    structuralClusters: clusters.filter(item => item.isStructural),
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    cycles: [],
    statistics: { nodeCount: files.length, edgeCount: edges.length, importEdgeCount: edges.length, httpEdgeCount: 0, clusterCount: clusters.length, structuralClusterCount: clusters.filter(item => item.isStructural).length, cycleCount: 0, avgDegree: 0, density: 0 },
  };
}

describe('domain file roles', () => {
  it('keeps tests supporting and fixture/generated/tooling files excluded', () => {
    expect(classifyDomainFile(file('src/generator/run.test.ts', { isTest: true }))).toEqual({ role: 'supporting', reason: 'test-file' });
    expect(classifyDomainFile(file('src/analyzer/fixtures/app.ts'))).toEqual({ role: 'excluded', reason: 'fixture-tree' });
    expect(classifyDomainFile(file('src/analyzer/__snapshots__/app.snap.ts'))).toEqual({ role: 'excluded', reason: 'fixture-tree' });
    expect(classifyDomainFile(file('samples/polyglot/App.kt'))).toEqual({ role: 'excluded', reason: 'fixture-tree' });
    expect(classifyDomainFile(file('src/main/java/org/springframework/samples/petclinic/owner/Owner.java', { extension: '.java' })))
      .toEqual({ role: 'defining', reason: 'production-source' });
    expect(classifyDomainFile(file('src/generated/client.ts', { isGenerated: true }))).toEqual({ role: 'excluded', reason: 'generated-file' });
    expect(classifyDomainFile(file('AGENTS.md', { tooling: true }))).toEqual({ role: 'excluded', reason: 'tooling-file' });
  });

  it('keeps documentation supporting so prose never defines a domain', () => {
    // Prose describes a system, it does not implement one: a requirement can never
    // be anchored to it. `supporting` (not `excluded`) so a code domain still keeps
    // its docs as footprint evidence.
    for (const path of ['README.md', 'docs/guide.mdx', 'CHANGELOG.md', 'doc/manual.rst', '.cursor/rules/x.mdc', 'README.txt', 'LICENSE.txt']) {
      expect(classifyDomainFile(file(path)), path).toEqual({ role: 'supporting', reason: 'documentation-file' });
    }
    // Extension-less project meta is matched by its conventional stem, including
    // the qualified variants (`LICENSE-MIT`, `COPYING.LESSER`) real repos ship.
    for (const path of [
      'LICENSE', 'NOTICE', 'COPYING', 'AUTHORS', 'packages/api/LICENSE',
      'LICENSE-MIT', 'LICENSE_APACHE', 'COPYING.LESSER',
    ]) {
      expect(classifyDomainFile(file(path)), path).toEqual({ role: 'supporting', reason: 'documentation-file' });
    }
    // Prose about configuration is still prose, even though the walker flags the
    // name as config.
    expect(classifyDomainFile(file('docs/config.md', { isConfig: true })))
      .toEqual({ role: 'supporting', reason: 'documentation-file' });
    // `.txt` carries prose and build config alike, so the config names are named:
    // these fall through to the ordinary config rule instead of becoming prose.
    // The walker's CONFIG_PATTERNS names none of these, so `isConfig` is false and
    // they must be excluded on their own merit — otherwise a Python or CMake
    // project's dependency file could define a domain.
    for (const path of ['requirements.txt', 'requirements-dev.txt', 'constraints.txt', 'CMakeLists.txt']) {
      expect(classifyDomainFile(file(path)), path).toEqual({ role: 'excluded', reason: 'config-file' });
    }
    // The exception is anchored on the whole basename: prose that merely contains
    // one of those words stays prose, so it can never define a domain.
    for (const path of ['docs/product-requirements.txt', 'docs/security-constraints.txt']) {
      expect(classifyDomainFile(file(path)), path).toEqual({ role: 'supporting', reason: 'documentation-file' });
    }

    // Project metadata is conventionally UPPER-CASE. Without that requirement an
    // extensionless executable would read as prose and its domain would vanish.
    for (const path of [
      'src/license/license.ts', 'src/docs/readme-generator.ts', 'src/changelog.ts',
      'bin/readme', 'scripts/changelog', 'src/license',
    ]) {
      expect(classifyDomainFile(file(path)), path).toEqual({ role: 'defining', reason: 'production-source' });
    }
  });
});

describe('reconcileRepositoryDomains', () => {
  it('merges technical children, then attaches tests without letting them define candidates', () => {
    const run = file('src/core/generator/run.ts');
    const stage = file('src/core/generator/stages/stage.ts');
    const helper = file('src/core/generator/stages/helper.ts');
    const test = file('src/core/generator/stages/stage.test.ts', { isTest: true });
    const files = [run, stage, helper, test];
    const result = reconcileRepositoryDomains(
      repo(files, { generator: [run, stage, helper] }),
      graph(files, [cluster('stages', 'src/core/generator/stages', [stage, helper], { cohesion: 0.5 })]),
    );

    expect(result.domains.map(item => item.name)).toEqual(['generator']);
    expect(result.domains[0].definingFiles.map(item => item.path)).toEqual([run.path, helper.path, stage.path].sort());
    expect(result.domains[0].supportingFiles.map(item => item.path)).toEqual([test.path]);
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: 'stages', disposition: 'merged', reason: 'technical-child', owner: 'generator' }));
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: 'stages', sources: ['dependency-cluster', 'technical-role'] }));
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: test.path, disposition: 'attached', reason: 'supporting-path-owner', owner: 'generator' }));
  });

  it('never promotes a documentation-only tree to a domain', () => {
    // The failure this closes: a docs/licence tree became a domain, the spec
    // workflows offered it as a target, and the host authored SHALL requirements
    // over prose. No new mechanism — documentation is non-defining, so the
    // existing `non-defining-only` rule drops the candidate.
    const readme = file('docs/README.md');
    const guide = file('docs/guide.md');
    const licence = file('docs/LICENSE');
    const files = [readme, guide, licence];
    const result = reconcileRepositoryDomains(
      repo(files, { docs: files }),
      graph(files, [cluster('docs', 'docs', files)]),
    );

    expect(result.domains).toEqual([]);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      candidate: 'docs', disposition: 'excluded', reason: 'non-defining-only',
    }));
  });

  it('records a documentation-only DIRECTORY candidate as excluded, never promoted', () => {
    // The directory path decides on `candidate.files`, which is already filtered to
    // defining files at construction — so a prose-only directory reaches the
    // zero-length branch and is disclosed as excluded, not promoted-then-emptied.
    const readme = file('docs/README.md');
    const guide = file('docs/guide.md');
    const files = [readme, guide];
    const result = reconcileRepositoryDomains(repo(files, { docs: files }), graph(files, []));

    expect(result.domains).toEqual([]);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      candidate: 'docs', disposition: 'excluded', reason: 'non-defining-only',
    }));
    expect(result.decisions.some(item => item.candidate === 'docs' && item.disposition === 'promoted')).toBe(false);
  });

  it('keeps a code domain\'s own documentation attached as supporting evidence', () => {
    const service = file('src/billing/service.ts');
    const readme = file('src/billing/README.md');
    const files = [service, readme];
    const result = reconcileRepositoryDomains(
      repo(files, { billing: [service] }),
      graph(files, [cluster('billing', 'src/billing', [service])]),
    );

    expect(result.domains.map(item => item.name)).toEqual(['billing']);
    expect(result.domains[0].definingFiles.map(item => item.path)).toEqual([service.path]);
    expect(result.domains[0].supportingFiles.map(item => item.path)).toEqual([readme.path]);
  });

  it('excludes fixture-only clusters and discloses their files', () => {
    const fixtureA = file('src/analyzer/fixtures/a.ts');
    const fixtureB = file('src/analyzer/fixtures/b.ts');
    const files = [fixtureA, fixtureB];
    const result = reconcileRepositoryDomains(
      repo(files, {}),
      graph(files, [cluster('fixtures', 'src/analyzer/fixtures', files)]),
    );

    expect(result.domains).toEqual([]);
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: 'fixtures', disposition: 'excluded', reason: 'non-defining-only' }));
    expect(result.unattachedEvidence.map(item => item.path)).toEqual([fixtureA.path, fixtureB.path]);
  });

  it('cannot reintroduce a corpus-excluded file through graph projection', () => {
    const production = file('src/generator/run.ts');
    const excludedBeforeMapping = file('examples/sample-app/orders.ts');
    const result = reconcileRepositoryDomains(
      repo([production], { generator: [production] }),
      graph([production, excludedBeforeMapping], [cluster('examples', 'examples/sample-app', [excludedBeforeMapping])]),
    );

    expect(result.domains.map(item => item.name)).toEqual(['generator']);
    expect(result.domains.flatMap(item => item.definingFiles.map(entry => entry.path))).not.toContain(excludedBeforeMapping.path);
  });

  it('records filename and deterministic boundary signals on the normalized candidate', () => {
    const route = file('src/billing/billing-route.ts', { isEntryPoint: true });
    const schema = file('src/billing/billing-schema.ts');
    const result = reconcileRepositoryDomains(
      repo([route, schema], { billing: [route, schema] }),
      graph([route, schema]),
      { entryFiles: [route.path], routeFiles: [route.path], schemaFiles: [schema.path] },
    );

    expect(result.decisions).toContainEqual(expect.objectContaining({
      candidate: 'billing',
      sources: ['directory', 'filename', 'public-entry', 'route', 'schema'],
    }));
  });

  it('does not let supporting files satisfy structural-independence thresholds', () => {
    const root = file('src/core/payments/index.ts');
    const childA = file('src/core/payments/refunds/create.ts');
    const childB = file('src/core/payments/refunds/cancel.ts');
    const test = file('src/core/payments/refunds/refunds.test.ts', { isTest: true });
    const files = [root, childA, childB, test];
    const result = reconcileRepositoryDomains(
      repo(files, { payments: [root, childA, childB] }),
      graph(files, [cluster('refunds', 'src/core/payments/refunds', [childA, childB, test])]),
    );

    expect(result.domains.map(item => item.name)).toEqual(['payments']);
    expect(result.domains[0].supportingFiles.map(item => item.path)).toEqual([test.path]);
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: 'refunds', disposition: 'merged', reason: 'contained-footprint' }));
  });

  it('discloses a test with only a generic source-root prefix and no import owner', () => {
    const generator = file('src/generator/run.ts');
    const auth = file('src/auth/login.ts');
    const unrelated = file('src/unrelated.test.ts', { isTest: true });
    const result = reconcileRepositoryDomains(
      repo([generator, auth, unrelated], { generator: [generator], auth: [auth] }),
      graph([generator, auth, unrelated]),
    );

    expect(result.domains.flatMap(domain => domain.supportingFiles)).toEqual([]);
    expect(result.unattachedEvidence).toContainEqual({
      path: unrelated.path, role: 'supporting', reason: 'test-file',
    });
    expect(result.decisions).toContainEqual(expect.objectContaining({
      candidate: unrelated.path, disposition: 'excluded', reason: 'supporting-unattached',
    }));
  });

  it('promotes a singleton nested module with an explicit route boundary', () => {
    const rootA = file('src/core/payments/pay.ts');
    const rootB = file('src/core/payments/store.ts');
    const refundsRoute = file('src/core/payments/refunds/routes.ts');
    const files = [rootA, rootB, refundsRoute];
    const result = reconcileRepositoryDomains(
      repo(files, { payments: files }),
      graph(files),
      { routeFiles: [refundsRoute.path] },
    );

    expect(result.domains.map(domain => domain.name)).toEqual(['payments', 'refunds']);
    expect(result.domains.find(domain => domain.name === 'refunds')?.definingFiles.map(item => item.path))
      .toEqual([refundsRoute.path]);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      candidate: 'refunds', disposition: 'promoted', reason: 'independent-boundary', owner: 'refunds', sources: ['route'],
    }));
  });

  it('preserves a nested structural business module but merges an unbounded technical role', () => {
    const root = file('src/core/payments/index.ts');
    const refunds = [
      file('src/core/payments/refunds/create.ts'),
      file('src/core/payments/refunds/cancel.ts'),
      file('src/core/payments/refunds/store.ts'),
    ];
    const utils = [file('src/core/payments/utils/money.ts'), file('src/core/payments/utils/currency.ts')];
    const files = [root, ...refunds, ...utils];
    const result = reconcileRepositoryDomains(
      repo(files, { payments: files }),
      graph(files, [
        cluster('refunds', 'src/core/payments/refunds', refunds),
        cluster('utils', 'src/core/payments/utils', utils),
      ]),
    );

    expect(result.domains.map(item => item.name)).toEqual(['payments', 'refunds']);
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: 'refunds', disposition: 'promoted', reason: 'structural-independence' }));
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: 'utils', disposition: 'merged', owner: 'payments' }));
  });

  it('uses import ownership when a supporting test has no path owner', () => {
    const production = file('src/core/generator/run.ts');
    const test = file('test/run.test.ts', { isTest: true });
    const files = [production, test];
    const result = reconcileRepositoryDomains(
      repo(files, { generator: [production] }),
      graph(files, [], [{ source: test.absolutePath, target: production.absolutePath, importedNames: ['run'], isTypeOnly: false, weight: 1 }]),
    );

    expect(result.domains[0].supportingFiles.map(item => item.path)).toEqual([test.path]);
    expect(result.decisions).toContainEqual(expect.objectContaining({ candidate: test.path, reason: 'supporting-import-owner', owner: 'generator' }));
  });

  it('prefers import ownership when generic directory-prefix scores tie', () => {
    const analyzer = file('src/core/analyzer/run.ts');
    const generator = file('src/core/generator/run.ts');
    const test = file('src/core/shared.test.ts', { isTest: true });
    const files = [analyzer, generator, test];
    const result = reconcileRepositoryDomains(
      repo(files, { analyzer: [analyzer], generator: [generator] }),
      graph(files, [], [{ source: test.absolutePath, target: generator.absolutePath, importedNames: ['run'], isTypeOnly: false, weight: 1 }]),
    );

    expect(result.domains.find(domain => domain.name === 'generator')?.supportingFiles.map(item => item.path))
      .toEqual([test.path]);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      candidate: test.path, reason: 'supporting-import-owner', owner: 'generator',
    }));
  });

  it('discloses supporting evidence when import ownership is tied', () => {
    const auth = file('src/auth/login.ts');
    const billing = file('src/billing/pay.ts');
    const test = file('test/integration.test.ts', { isTest: true });
    const files = [auth, billing, test];
    const result = reconcileRepositoryDomains(
      repo(files, { auth: [auth], billing: [billing] }),
      graph(files, [], [
        { source: test.absolutePath, target: auth.absolutePath, importedNames: ['login'], isTypeOnly: false, weight: 1 },
        { source: test.absolutePath, target: billing.absolutePath, importedNames: ['pay'], isTypeOnly: false, weight: 1 },
      ]),
    );

    expect(result.domains.flatMap(domain => domain.supportingFiles)).toEqual([]);
    expect(result.unattachedEvidence).toContainEqual({ path: test.path, role: 'supporting', reason: 'test-file' });
  });

  it('keeps repeated technical schema/route boundaries attached to their ownership roots', () => {
    const orderModel = file('src/orders/entities/order.ts');
    const orderSchema = file('src/orders/schema/order-schema.ts');
    const userModel = file('src/users/models/user.ts');
    const orderRoute = file('src/orders/api/index.ts');
    const orderEndpoint = file('src/orders/endpoints/list.ts');
    const userRoute = file('src/users/routes/index.ts');
    const files = [orderModel, orderSchema, userModel, orderRoute, orderEndpoint, userRoute];
    const result = reconcileRepositoryDomains(
      repo(files, { orders: [orderModel, orderSchema, orderRoute, orderEndpoint], users: [userModel, userRoute] }),
      graph(files),
      {
        schemaFiles: [orderModel.path, orderSchema.path, userModel.path],
        routeFiles: [orderRoute.path, orderEndpoint.path, userRoute.path],
      },
    );

    expect(result.domains.map(domain => domain.name)).toEqual(['orders', 'users']);
    expect(result.domains.find(domain => domain.name === 'orders')?.definingFiles.map(item => item.path).sort())
      .toEqual([orderModel.path, orderSchema.path, orderRoute.path, orderEndpoint.path].sort());
    expect(result.domains.find(domain => domain.name === 'users')?.definingFiles.map(item => item.path).sort())
      .toEqual([userModel.path, userRoute.path].sort());
    expect(result.domains.map(domain => domain.name)).not.toContain('domain');
    expect(result.domains.map(domain => domain.name)).not.toContain('api');
  });

  it('does not let a cross-root graph cluster broaden or duplicate ownership', () => {
    const analyzerA = file('src/core/analyzer/a.ts');
    const analyzerB = file('src/core/analyzer/b.ts');
    const serviceA = file('src/core/services/mcp-handlers/a.ts');
    const serviceB = file('src/core/services/mcp-handlers/b.ts');
    const files = [analyzerA, analyzerB, serviceA, serviceB];
    const result = reconcileRepositoryDomains(
      repo(files, { analyzer: [analyzerA, analyzerB], services: [serviceA, serviceB] }),
      graph(files, [cluster('analyzer-cross-root', 'src/core/analyzer', files)]),
    );

    expect(result.domains.map(item => item.name)).toEqual(['analyzer', 'services']);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      candidate: 'analyzer', disposition: 'merged', reason: 'contained-footprint',
    }));
    const memberships = result.domains.flatMap(domain => domain.definingFiles.map(item => item.path));
    expect(new Set(memberships).size).toBe(memberships.length);
  });

  it('is independent of candidate, file, and cluster iteration order', () => {
    const files = [file('src/core/generator/a.ts'), file('src/core/generator/stages/b.ts'), file('src/core/generator/stages/c.ts')];
    const forward = reconcileRepositoryDomains(
      repo(files, { generator: files }),
      graph(files, [cluster('stages', 'src/core/generator/stages', files.slice(1))]),
    );
    const reverse = reconcileRepositoryDomains(
      repo([...files].reverse(), { generator: [...files].reverse() }),
      graph([...files].reverse(), [cluster('stages', 'src/core/generator/stages', [...files.slice(1)].reverse())]),
    );
    expect(reverse).toEqual(forward);
  });

  it('bounds decision payloads and discloses omitted audit records', () => {
    const production = Array.from({ length: 60 }, (_, index) => file(`src/generator/f${index}.ts`));
    const tests = Array.from({ length: 510 }, (_, index) => file(`test/case-${index}.test.ts`, { isTest: true }));
    const files = [...production, ...tests];
    const result = reconcileRepositoryDomains(
      repo(files, { generator: production }),
      graph(files),
    );

    expect(result.decisionSummary).toEqual({
      total: 511, emitted: 500, omitted: 11, limit: 500, filesPerDecisionLimit: 50,
    });
    expect(Math.max(...result.decisions.map(item => item.files.length))).toBeLessThanOrEqual(50);
  });

  it('has no second silent technical-directory denylist after projection', async () => {
    const source = await readFile(new URL('./artifact-generator.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/skipDirs/);
    expect(source).toContain('reconcileRepositoryDomains');
  });
});
