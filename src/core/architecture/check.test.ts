import { describe, it, expect } from 'vitest';
import type { DependencyGraphResult } from '../analyzer/dependency-graph.js';
import type { ArchitectureRules } from './rules.js';
import { scanViolations, canImport, pathMatches } from './check.js';

const ROOT = '/repo/';

/** Build a minimal dependency graph from relative-path edges. */
function depGraph(
  edges: Array<[string, string]>,
  exportsByFile: Record<string, string[]> = {},
): DependencyGraphResult {
  const files = new Set<string>();
  for (const [a, b] of edges) { files.add(a); files.add(b); }
  for (const f of Object.keys(exportsByFile)) files.add(f);
  const nodes = [...files].map(rel => ({
    id: ROOT + rel,
    file: { path: rel, absolutePath: ROOT + rel },
    exports: (exportsByFile[rel] ?? []).map(name => ({
      name, isDefault: false, isType: false, isReExport: false, kind: 'function' as const, line: 1,
    })),
    metrics: {
      inDegree: edges.filter(([, target]) => target === rel).length,
      outDegree: edges.filter(([source]) => source === rel).length,
      betweenness: 0,
      pageRank: 0,
    },
  }));
  const depEdges = edges.map(([a, b]) => ({
    source: ROOT + a, target: ROOT + b, importedNames: [], isTypeOnly: false, weight: 1,
  }));
  return { nodes, edges: depEdges } as unknown as DependencyGraphResult;
}

function rules(...rs: ArchitectureRules['rules']): ArchitectureRules {
  return { rules: rs, warnings: [] };
}

describe('pathMatches', () => {
  it('treats a pattern as a directory prefix', () => {
    expect(pathMatches('src/core/x.ts', 'src/core')).toBe(true);
    expect(pathMatches('src/core/x.ts', 'src/core/')).toBe(true);
    expect(pathMatches('src/core/x.ts', 'src/core/**')).toBe(true);
    expect(pathMatches('src/cli/x.ts', 'src/core')).toBe(false);
    expect(pathMatches('src/coreutils/x.ts', 'src/core')).toBe(false); // no false prefix
  });
});

describe('scanViolations', () => {
  it('flags a "domain must not import infra" forbidden rule', () => {
    const g = depGraph([
      ['src/domain/order.ts', 'src/infra/db.ts'], // violation
      ['src/domain/order.ts', 'src/domain/money.ts'], // fine
    ]);
    const r = rules({ kind: 'forbidden', from: 'src/domain', to: 'src/infra', reason: 'domain stays infra-free', source: 'config' });
    const scan = scanViolations(g, r);
    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({
      kind: 'forbidden', from: 'src/domain/order.ts', to: 'src/infra/db.ts',
    });
    expect(scan.violations[0].reason).toContain('domain stays infra-free');
  });

  it('flags an upward layer dependency (reusing the call-graph primitive)', () => {
    const g = depGraph([
      ['src/core/x.ts', 'src/cli/y.ts'], // core (lower) → cli (upper): violation
      ['src/cli/y.ts', 'src/core/x.ts'], // cli → core: legal
    ]);
    const r = rules({ kind: 'layers', layers: { cli: ['src/cli'], core: ['src/core'] }, source: 'config' });
    const scan = scanViolations(g, r);
    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({ kind: 'layers', from: 'src/core/x.ts', to: 'src/cli/y.ts' });
  });

  it('layer prefixes match by path boundary, not substring (no false sibling match)', () => {
    // `src/clinic` must NOT be classified into the `cli` layer; `src/coreutils`
    // must NOT be classified into `core`. With substring matching both edges
    // would be mis-layered and one would be flagged as a violation.
    const g = depGraph([
      ['src/clinic/a.ts', 'src/coreutils/b.ts'],
      ['src/coreutils/b.ts', 'src/clinic/a.ts'],
    ]);
    const r = rules({ kind: 'layers', layers: { cli: ['src/cli'], core: ['src/core'] }, source: 'config' });
    const scan = scanViolations(g, r);
    expect(scan.violations).toHaveLength(0);
  });

  it('flags an allowedOnly module-boundary breach but allows intra-module + allowlisted', () => {
    const g = depGraph([
      ['src/api/a.ts', 'src/db/conn.ts'], // not allowlisted → violation
      ['src/api/a.ts', 'src/core/svc.ts'], // allowlisted → fine
      ['src/api/a.ts', 'src/api/b.ts'], // intra-module → fine
    ]);
    const r = rules({ kind: 'allowedOnly', module: 'src/api', mayDependOn: ['src/core'], source: 'config' });
    const scan = scanViolations(g, r);
    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({ to: 'src/db/conn.ts' });
  });

  it('flags each missing required dependency while accepting a conforming peer', () => {
    const g = depGraph([
      ['src/handlers/clean.ts', 'src/sanitizer/index.ts'],
      ['src/handlers/raw.ts', 'src/model.ts'],
    ]);
    const scan = scanViolations(g, rules({
      kind: 'required', from: 'src/handlers', to: 'src/sanitizer', source: 'config',
    }));

    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({
      kind: 'required', from: 'src/handlers/raw.ts', to: 'src/sanitizer',
    });
  });

  it('reports deterministic cycles and honors scoped exceptions', () => {
    const g = depGraph([
      ['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/a.ts'],
      ['src/generated/x.ts', 'src/generated/y.ts'], ['src/generated/y.ts', 'src/generated/x.ts'],
    ]);
    const scan = scanViolations(g, rules({
      kind: 'circular', scope: 'src', allowed: ['src/generated'], source: 'config',
    }));

    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({ kind: 'circular', path: ['src/a.ts', 'src/b.ts'] });
  });

  it('does not let a capture exception hide a cross-capture cycle', () => {
    const g = depGraph([
      ['domains/billing/a.ts', 'domains/orders/b.ts'],
      ['domains/orders/b.ts', 'domains/billing/a.ts'],
    ]);
    const scan = scanViolations(g, rules({
      kind: 'circular', scope: 'domains', allowed: ['domains/$1'], source: 'config',
    }));

    expect(scan.violations).toHaveLength(1);
  });

  it('distinguishes an outside reachability breach from an allowed origin', () => {
    const g = depGraph([
      ['src/public/api.ts', 'src/internal/service.ts'],
      ['src/rogue.ts', 'src/middle.ts'],
      ['src/middle.ts', 'src/internal/service.ts'],
    ]);
    const scan = scanViolations(g, rules({
      kind: 'reachable', from: 'src/public', to: 'src/internal', source: 'config',
    }));

    expect(scan.violations.map(violation => violation.from)).toEqual(['src/middle.ts', 'src/rogue.ts']);
    expect(scan.violations.find(violation => violation.from === 'src/rogue.ts')).toMatchObject({
      path: ['src/rogue.ts', 'src/middle.ts', 'src/internal/service.ts'],
      relatedConclusion: 'find_dead_code',
    });
  });

  it('flags only matched files with no incoming dependency as orphans', () => {
    const g = depGraph([
      ['src/app.ts', 'src/lib/used.ts'],
      ['src/lib/orphan.ts', 'src/shared.ts'],
    ]);
    const scan = scanViolations(g, rules({ kind: 'orphan', scope: 'src/lib', source: 'config' }));

    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({
      kind: 'orphan', from: 'src/lib/orphan.ts', relatedConclusion: 'find_dead_code',
    });
  });

  it('flags only strict instability inversions using stored graph degrees', () => {
    const g = depGraph([
      ['src/client-a.ts', 'src/core/stable.ts'],
      ['src/client-b.ts', 'src/core/stable.ts'],
      ['src/core/stable.ts', 'src/util/unstable.ts'],
      ['src/util/unstable.ts', 'src/leaf-a.ts'],
      ['src/util/unstable.ts', 'src/leaf-b.ts'],
    ]);
    const scan = scanViolations(g, rules({
      kind: 'moreUnstable', scope: 'src/core', source: 'config',
    }));

    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({
      kind: 'moreUnstable',
      from: 'src/core/stable.ts',
      to: 'src/util/unstable.ts',
      instability: { dependent: 1 / 3, dependency: 2 / 3 },
    });
  });

  it('binds one path-segment capture across allowedOnly patterns', () => {
    const g = depGraph([
      ['domains/billing/a.ts', 'domains/billing/b.ts'],
      ['domains/billing/a.ts', 'shared/log.ts'],
      ['domains/billing/a.ts', 'domains/orders/b.ts'],
    ]);
    const scan = scanViolations(g, rules({
      kind: 'allowedOnly',
      module: 'domains/$1',
      mayDependOn: ['domains/$1', 'shared'],
      source: 'config',
    }));

    expect(scan.violations).toHaveLength(1);
    expect(scan.violations[0]).toMatchObject({
      from: 'domains/billing/a.ts', to: 'domains/orders/b.ts',
    });
  });

  it('discloses lower-confidence call edges used by a verdict', () => {
    const g = depGraph([['src/core/a.ts', 'src/cli/b.ts']]);
    g.edges[0].isCallEdge = true;
    g.edges[0].resolutionConfidence = 'name_only';
    const scan = scanViolations(g, rules({
      kind: 'forbidden', from: 'src/core', to: 'src/cli', source: 'config',
    }));

    expect(scan.violations[0].confidence).toBe('name_only');
  });

  it('is fully inert with no rules', () => {
    const g = depGraph([['src/a.ts', 'src/b.ts']]);
    const scan = scanViolations(g, rules());
    expect(scan).toMatchObject({ violations: [], rulesApplied: 0, checkedEdges: 0 });
  });

  it('warns (does not throw) on a rule prefix that matches no file', () => {
    const g = depGraph([['src/a.ts', 'src/b.ts']]);
    const r = rules({ kind: 'forbidden', from: 'src/nonexistent', to: 'src/b', source: 'config' });
    const scan = scanViolations(g, r);
    expect(scan.violations).toHaveLength(0);
    expect(scan.warnings.some(w => w.includes('src/nonexistent'))).toBe(true);
  });
});

describe('canImport (pre-edit query)', () => {
  const r = rules({ kind: 'forbidden', from: 'src/domain', to: 'src/infra', source: 'config' });

  it('denies a disallowed file import and names the rule', () => {
    const v = canImport('src/domain/order.ts', 'src/infra/db.ts', r);
    expect(v.allowed).toBe(false);
    expect(v.rule?.kind).toBe('forbidden');
    expect(v.reason).toContain('violates a forbidden rule');
  });

  it('allows a legal import', () => {
    expect(canImport('src/domain/order.ts', 'src/domain/money.ts', r).allowed).toBe(true);
  });

  it('resolves a bare exported symbol to its declaring file', () => {
    const g = depGraph([], { 'src/infra/db.ts': ['connect'] });
    const v = canImport('src/domain/order.ts', 'connect', r, g);
    expect(v.allowed).toBe(false);
    expect(v.resolvedTo).toBe('src/infra/db.ts');
  });

  it('is permissive (with a note) when a symbol cannot be resolved', () => {
    const g = depGraph([], {});
    const v = canImport('src/domain/order.ts', 'NoSuchSymbol', r, g);
    expect(v.allowed).toBe(true);
    expect(v.rule?.kind).toBe('unresolved');
  });

  it('is inert with no rules declared', () => {
    expect(canImport('a.ts', 'b.ts', rules()).allowed).toBe(true);
  });
});
